/*
 * @package node-sftp
 * @copyright Copyright (C) 2011 Ajax.org. All rights reserved.
 * @author Mike de Boer <mike AT ajax DOT org>
 * @license Commercial.
 */

var Child_process = require("child_process");
var Fs = require("fs");
var Events = require("events")
var Util = require("./util");
var Ssh = require("./ssh");

function Sftp(options) {
    Events.EventEmitter.call(this);

    this.options = Util.extend({
        host: "localhost",
        port: 22,
        timeout: 10000
    }, options || {});
    if (this.options.connect)
        this.connect();
}

require("util").inherits(Sftp, Events.EventEmitter);

(function() {
    this.activeCmd = null;
    this.callbacks = {};
    this.queue = [];
    this.connected = false;

    this.connect = function(cbconnect) {
        if (this.child)
            return this.child;
        var args  = ["-v"],
            o     = this.options,
            _self = this;
            
        // setup arguments to pass into spawn()
        if (o.privateKey) {
            // plaintext private key needs to be written to file first
            if (o.privateKey.indexOf("BEGIN RSA PRIVATE KEY") > 0) {
                Ssh.writeKeyFile(o.privateKey, function(err, file) {
                    if (err)
                        return cbconnect(err);
                    args = args.concat(Ssh.buildArgs(file));
                    afterArgs();
                });
            }
            else {
                args = args.concat(Ssh.buildArgs(o.privateKey));
                afterArgs();
            }
        }
        else
            afterArgs();
        
        function afterArgs() {
            args.push((o.username ? o.username + "@" : "") + o.host);
            // push the connection string as argument:
            console.log("launching: sftp " + args.join(" "));
            
            _self.child = Child_process.spawn("sftp", args);
            console.log("pass?", o.password);
            //if (o.password)
            //    _self.child.stdin.write(o.password);
            //_self.child.stdin.resume();
            
            // setup listeners:
            _self.child.stdin.setEncoding("utf8");
            _self.child.stdout.setEncoding("utf8");
            _self.child.stderr.setEncoding("utf8");

            _self.child.stdin.on("data", function(data) {
                console.log("IN incoming:", data);
            });
            _self.child.stdout.on("data", function(data) {
                parseReply.call(_self, data, 1);
            });
            _self.child.stderr.on("data", function(data) {
                parseReply.call(_self, data, 2);
            });
            _self.child.on("exit", function(code) {
                _self.emit("disconnect", code);
            });
            
            _self.callbacks["connect"] = function() {
                if (o.home)
                    _self.cd(o.home, function() {});
                cbconnect();
            };
        }
    };
    
    /*
     Available commands:
        bye                                Quit sftp
        cd path                            Change remote directory to 'path'
        chgrp grp path                     Change group of file 'path' to 'grp'
        chmod mode path                    Change permissions of file 'path' to 'mode'
        chown own path                     Change owner of file 'path' to 'own'
        df [-hi] [path]                    Display statistics for current directory or
                                           filesystem containing 'path'
        exit                               Quit sftp
        get [-P] remote-path [local-path]  Download file
        help                               Display this help text
        lcd path                           Change local directory to 'path'
        lls [ls-options [path]]            Display local directory listing
        lmkdir path                        Create local directory
        ln oldpath newpath                 Symlink remote file
        lpwd                               Print local working directory
        ls [-1aflnrSt] [path]              Display remote directory listing
        lumask umask                       Set local umask to 'umask'
        mkdir path                         Create remote directory
        progress                           Toggle display of progress meter
        put [-P] local-path [remote-path]  Upload file
        pwd                                Display remote working directory
        quit                               Quit sftp
        rename oldpath newpath             Rename remote file
        rm path                            Delete remote file
        rmdir path                         Remove remote directory
        symlink oldpath newpath            Symlink remote file
        version                            Show SFTP version
        !command                           Execute 'command' in local shell
        !                                  Escape to local shell
        ?                                  Synonym for help
    */
    this.disconnect = function(cbdisconn) {
        var _self = this;
        this.send("bye", "bye", function(data) {
            _self.child = null;
            _self.connected = false;
            _self.emit("disconnect");
            cbdisconn();
        });
    };
    
    this.cd = function(path, cbcd) {
        this.send("cd", "cd " + (path || ""), function(data) {
            cbcd(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    this.chgrp = function(group, path, cbchgrp) {
        this.send("chgrp", "chgrp " + group + " " + (path || ""), function(data) {
            cbchgrp(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    this.chmod = function(mode, path, cbchmod) {
        this.send("chmod", "chmod " + mode + " " + (path || ""), function(data) {
            cbchmod(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    this.chown = function(own, path, cbchgrp) {
        this.send("chown", "chown " + own + " " + (path || ""), function(data) {
            cbchown(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    this.get = function(path, to, cbget) {
        if (!to)
            to = Util.DEFAULT_TMPDIR + "/" + Util.uuid();
        var timer,
            _self = this;
        
        function startWatch() {
            Fs.watchFile(to, { persistent: true, interval: 10 }, function(curr, prev) {
                clearTimeout(timer);
                setTimeout(function() {
                    cbget(null, to);
                }, 100);
            });
        }

        function receiveChunk(s) {
            console.log("received? ", s);
            if (s.indexOf("not found.") > -1)
                return cbget(s, to);
            if (s.indexOf("Fetching") > -1)
                return startWatch();
            _self.activeCmd = "get";
            _self.callbacks["get"] = receiveChunk;
        }
        this.send("get", "get " + path + " " + to, receiveChunk);
    };
    
    this.ln = this.symlink = function(oldpath, newpath, cbln) {
        this.send("ln", "ln " + oldpath + " " + newpath, function(data) {
            cbln(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    function parseListing(data) {
        var lines = [];
        if (data.indexOf("ls -aln") > -1)
            return lines;
        data.split(/\n/).forEach(function(line) {
            if (!line || /\/[\.]{1,2}$/.test(line))
                return;
            var m = line.match(/^([drwx-]+)[\s]*([\d]+)[\s]*([\d]+)[\s]*([\d]+)[\s]*([\d]+)[\s]*([\w\s\d]*)([\d]{2}\:[\d]{2})[\s]*(.*)$/);
            lines.push({
                perms: m[1],
                uid: parseInt(m[3]),
                gid: parseInt(m[4]),
                size: parseInt(m[5]),
                date: m[6],
                time: m[7],
                path: m[8]
            });
        });
        return lines;
    }

    this.ls = function(path, cbls) {
        var timeout,
            listing = [],
            _self = this;

        function receiveChunk(s) {
            clearTimeout(timeout);
            _self.activeCmd = "ls";
            _self.callbacks["ls"] = receiveChunk;
            listing = listing.concat(parseListing(s));
            s = null;
            timeout = setTimeout(function() {
                _self.activeCmd = null;
                delete _self.callbacks["ls"];
                cbls(null, listing);
                if (_self.queue.length)
                    _self.send.apply(_self, _self.queue.shift());
            }, 1000);
        }

        this.send("ls", "ls -aln " + (path || ""), receiveChunk);
    };
    
    this.mkdir = function(path, cbmkdir) {
        this.send("mkdir", "mkdir " + (path || ""), function(data) {
            cbmkdir(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    this.put = function(path, from, cbput) {
        //@todo
    };
    
    this.pwd = function(cbpwd) {
        this.send("pwd", "pwd", function(data) {
            // getting back on stdin:
            // sftp> pwd 
            // Remote working directory: /home/cloud9
            cbpwd(null, data.replace(/[\n\r]+/g, "").replace(/[^:]+:[\s]*([^s]+)/g, "$1"));
        });
    };
    
    this.rename = function(oldpath, path, cbrename) {
        this.send("rename", "rename " + olpath + " " + (path || oldpath), function(data) {
            cbrename(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    this.rm = function(path, cbrm) {
        this.send("rm", "rm " + path, function(data) {
            cbrm(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    this.rmdir = function(path, cbrmdir) {
        this.send("rmdir", "rmdir " + path, function(data) {
            cbrmdir(data.indexOf("ERR") > -1 ? data : null);
        });
    };
    
    var _slice = Array.prototype.slice;

    this.send = function(type, cmd, cbsend) {
        if (!this.connected || this.activeCmd || !this.child)
            return this.queue.push([type, cmd, cbsend]);
        
        this.activeCmd = type;
        this.callbacks[type] = cbsend;
        this.child.stdin.write(new Buffer(cmd + "\r\n"));
        this.child.stdin.resume();
    };
    
    function parseReply(data, origin) {
        //if (origin === 1)
        //    console.log("data: ", data, "active command:", this.activeCmd);
        if (data.indexOf("Sending subsystem: sftp") > -1 && this.callbacks["connect"]) {
            this.connected = true;
            this.callbacks["connect"]();
            delete this.callbacks["connect"];
            this.emit("connect");
        }
        // check if a command is being executed:
        else if (this.activeCmd && this.callbacks[this.activeCmd]) {
            var cb = this.callbacks[this.activeCmd];
            delete this.callbacks[this.activeCmd];
            this.activeCmd = null;
            if (origin == 2 && data.indexOf("debug") > -1) {
                //console.log("STDERR:", data);
                return;
            }
            cb(data);
        }
        
        if (!this.activeCmd && this.queue.length)
            this.send.apply(this, this.queue.shift());
    }
}).call(Sftp.prototype);

module.exports = Sftp;
