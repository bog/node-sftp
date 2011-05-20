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
var Socket = require("net").Socket;
var Tty = require("tty");

function Sftp(options, cbconnect) {
    Events.EventEmitter.call(this);

    this.options = Util.extend({
        host: "localhost",
        port: 22,
        timeout: 10000,
        autoconnect: true
    }, options || {});
    
    this.state = 0;
    
    var o     = this.options,
        _self = this;
    // plaintext private key needs to be written to file first
    if (o.privateKey && o.privateKey.indexOf("BEGIN RSA PRIVATE KEY") > 0) {
        var _self = this;
        Ssh.writeKeyFile(o.privateKey, function(err, file) {
            if (err)
                return cbconnect(err);
            o.privateKey = file;
            _self.$privateKeyTemp = file;
            afterInit();
        });
    }
    else
        afterInit();

    function afterInit() {
        _self.state = Sftp.STATE_DISCONNECTED;
        _self.emit("ready");
        cbconnect = cbconnect || o.callback || K;

        if (o.exec) {
            var args = o.exec.split(" "),
                func = parts.shift(),
                cb   = o.callback || cbconnect;
            if (!_self[func])
                return cb("Unsupported method '" + func + "' specified in the exec option");
            _self.connect(cbconnect);
            args.push(cb);
            _self[func].apply(_self, args);
        }
        else if (_self.queue.length) {
            _self.connect(cbconnect);
            _self.exec.apply(_self, _self.queue.shift());
        }
        else if (o.autoconnect) {
            _self.connect(cbconnect);
        }
    }
}

Sftp.STATE_CONNECTED    = 0x0001;
Sftp.STATE_CONNECTING   = 0x0002;
Sftp.STATE_DISCONNECTED = 0x0004;

require("util").inherits(Sftp, Events.EventEmitter);

(function() {
    this.activeCmd = null;
    this.activeCmdBuffer = "";
    this.callbacks = {};
    this.queue = [];
    this.cmdOptions = {};
    
    var K = function() {};
    
    this.connect = function(cbconnect) {
        if (!(this.state & Sftp.STATE_DISCONNECTED)) {
            if (cbconnect) {
                cbconnect(this.state & Sftp.STATE_CONNECTED 
                    ? null 
                    : this.state & Sftp.STATE_CONNECTING
                        ? "SFTP Error: already connecting to a host, please be patient" 
                        : "SFTP Error: invalid state."
                );
            }
            return;
        }

        this.state = Sftp.STATE_CONNECTING;

        var o     = this.options,
            args  = [], //["-v"],
            _self = this;
        if (o.privateKey)
            args = args.concat(Ssh.buildArgs(o.privateKey));
        args.push(
            // first we push the correct hostname (appended with the path, if supplied)
            (o.username ? o.username + "@" : "") + o.host + (o.home ? ":" + o.home : "")
        );
        // push the connection string as argument:
        console.log("launching: sftp " + args.join(" "));
        var ps = Tty.open("sftp", args);
        this.socket = ps[0];
        this.child = ps[1];

        this.socket.on("data", function(data) {
            if (_self.state & Sftp.STATE_DISCONNECTED)
                _self.socket.destroy();
            parseReply.call(_self, data.toString(), 1);
        });

        this.child.on("exit", function(code) {
            _self.emit("disconnect", code);
            _self.socket.flush();
            _self.state = Sftp.STATE_DISCONNECTED;
            if (_self.$privateKeyTemp)
                Fs.unlink(_self.$privateKeyTemp);
        });

        this.callbacks["connect"] = function() {
            _self.state = Sftp.STATE_CONNECTED;

            send.call(_self, "help", "help", function(lines) {
                registerFeatures.call(_self, lines);
                _self.emit("connect");
                cbconnect && cbconnect();

                if (_self.queue.length)
                    _self.exec.apply(_self, _self.queue.shift());
            }, K);
        };
    };
    
    function registerFeatures(lines) {
        lines = lines.slice(lines.indexOf("Available commands:") + 1);
        var _self = this;
        lines.forEach(function(line) {
            // parse the help output for a command
            var m = line.match(/^([^\t]*)[\s]{2,}([^\t]+)$/);
            if (!m || m.length != 3)
                return;
            // remove the unnecessary trailing spaces
            m[1] = m[1].replace(/[\s]+$/, "");
            if (!m[1])
                return;
            // parse the command structure to fetch the command options.
            // the regex is more generic then it must be, because I might use it
            // for something else later...
            m = m[1].match(/([^\s]*)(?:[\s]+)?([^\s]*)?(?:[\s]+)?([^\s]*)?(?:[\s]+)?([^\s]*)?/);
            if (m[2] && m[2].substr(0, 2) == "[-")
                _self.cmdOptions[m[1]] = m[2].substr(2, m[2].length - 3).split("");
        });
    }
    
    this.disconnect = function(cbdisconn) {
        if (this.state & Sftp.STATE_DISCONNECTED)
            return cbdisconn();
        var _self = this;
        this.exec("bye", "bye", function(lines) {
            _self.state = Sftp.STATE_DISCONNECTED;
            _self.emit("disconnect");
            _self.child && _self.child.kill && _self.child.kill();
            _self.child = null;
            _self.socket && _self.socket.destroy();
            if (_self.$privateKeyTemp)
                Fs.unlink(_self.$privateKeyTemp, cbdisconn);
            else
                cbdisconn();
        });
    };
    
    this.cd = function(path, cbcd) {
        this.exec("cd", "cd " + (path || ""), function(lines) {
            cbcd(isError(lines));
        });
    };
    
    this.chmod = function(path, mode, cbchmod) {
        if (typeof mode == "number")
            mode = mode.toString(8);
        this.exec("chmod", "chmod " + mode + " " + (path || ""), function(lines) {
            cbchmod(isError(lines));
        });
    };
    
    this.chown = function(path, own, cbchgrp) {
        this.exec("chown", "chown " + own + " " + (path || ""), function(lines) {
            cbchown(isError(lines));
        });
    };
    
    this.ln = this.symlink = function(oldpath, newpath, cbln) {
        this.exec("ln", "ln " + oldpath + " " + newpath, function(lines) {
            cbln(isError(lines));
        });
    };
    
    this.mkdir = function(path, cbmkdir) {
        this.exec("mkdir", "mkdir " + (path || ""), function(lines) {
            cbmkdir(isError(lines));
        });
    };
    
    this.pwd = function(cbpwd) {
        this.exec("pwd", "pwd", function(lines) {
            // getting back on stdin:
            // sftp> pwd 
            // Remote working directory: /home/cloud9
            cbpwd(null, lines.join("").replace(/[^:]+:[\s]*([^\n\r\t]+)/g, "$1"));
        });
    };
    
    function parseListing(lines) {
        var res = [];
        lines.forEach(function(line) {
            if (!line || /\/[\.]{1,2}$/.test(line))
                return;
            var m = line.match(/^[\s]*([drwx-]+)[\s]*([\d]+)[\s]*([\d]+)[\s]*([\d]+)[\s]*([\d]+)[\s]*([\w\s\d]*)([\d]{2}\:[\d]{2})[\s]*(.*)$/);
            if (!m)
                return;
            res.push({
                perms: m[1],
                uid: parseInt(m[3]),
                gid: parseInt(m[4]),
                size: parseInt(m[5]),
                date: m[6],
                time: m[7],
                path: m[8]
            });
        });
        return res;
    }

    function ls(path, cbls) {
        var cmd = "ls -l"
        if (this.cmdOptions["ls"].indexOf("a") > -1)
            cmd += "a";
        if (this.cmdOptions["ls"].indexOf("n") > -1)
            cmd += "n";
        this.exec("ls", cmd + " " + (path || ""), function(lines) {
            cbls(isError(lines), parseListing(lines));
        });
    };
    
    this.readdir = function(path, callback) {
        ls.call(this, path, function(err, listing) {
            if (err)
                return callback(err);

            callback(null, listing.map(function(item) {
                var p = item.path;
                return p.substr(p.lastIndexOf("/") + 1);
            }));
        });
    };
    
    this.readFile = function(filename, encoding, callback) {
        var temp = Util.DEFAULT_TMPDIR + "/" + Util.uuid();

        this.exec("readFile", "get " + filename + " " + temp, function(lines) {
            var err = isError(lines);
            if (err)
                return callback(err);
            Fs.readFile(temp, encoding, function(err, data) {
                if (err)
                    return callback(err);
                Fs.unlink(temp, function() {
                    // error? we don't care here...
                    callback(null, data);
                });
            });
        });
    };
    
    this.rename = function(path1, path2, cbrename) {
        this.exec("rename", "rename " + path1 + " " + (path2 || path1), function(lines) {
            cbrename(isError(lines));
        });
    };
    
    this.rmdir = function(path, cbrmdir) {
        this.exec("rmdir", "rmdir " + path, function(lines) {
            cbrmdir(isError(lines));
        });
    };
    
    function getOct(rwx) {
        var oct = "";
        for (var c, o = 0, i = 0, l = rwx.length; i < l; ++i) {
            c = rwx.charAt(i);
            if (i % 3 === 0) {
                oct += "" + o;
                o = 0;
            }
            c = rwx.charAt(i + 1);
            o += c == "r" ? 4 : c == "w" ? 2 : c == "x" ? 1 : 0;
        }
        return oct;
    }
    
    function Stat(struct) {
        this.uid = struct.uid;
        this.gid = struct.gid;
        this.mtime = struct.date + struct.time;
        this.size = struct.size;
        this.mode = parseInt(getOct(struct.perms), 10);
        
        this.isFile = function() {
            return struct.perms.charAt(0) == "-";
        };
        this.isDirectory = function() {
            return struct.perms.charAt(0) == "d";
        };
        this.isBlockDevice = function() {
            return struct.perms.charAt(0) == "b";
        };
        this.isCharacterDevice = function() {
            return struct.perms.charAt(0) == "c";
        };
        this.isSymbolicLink = function() {
            return struct.perms.charAt(0) == "l";
        };
        this.isFIFO = function() {
            return struct.perms.charAt(0) == "p";
        };
        this.isSocket = function() {
            return struct.perms.charAt(0) == "s";
        };
    }
    
    this.fstat =
    this.lstat =
    this.stat  = function(path, callback) {
        var _self = this,
            parts = path.split("/"),
            node  = parts.pop(),
            root  = parts.join("/");
        if (root.charAt(0) != "/") {
            this.pwd(function(err, pwd) {
                if (err)
                    return callback(err);
                pwd = pwd.replace(/[\/]+$/, "");
                root = pwd + "/" + root.replace(/^[\/]+/, "");
                afterPwd();
            });
        }
        else
            afterPwd();
        
        function afterPwd() {
            ls.call(_self, root, function(err, list) {
                list = list.filter(function(item) {
                    return item.path.split("/").pop() === node;
                });
                if (list.length === 0)
                    return callback("Couldn't stat remote file: No such file or directory");
                return callback(null, new Stat(list[0]));
            });
        }
    };
    
    this.unlink = function(path, cbrm) {
        this.exec("unlink", "rm " + path, function(lines) {
            cbrm(isError(lines));
        });
    };
    
    this.writeFile = function(filename, data, encoding, callback) {
        encoding  = encoding || "utf8";
        var temp  = Util.DEFAULT_TMPDIR + "/" + Util.uuid(),
            _self = this;

        Fs.writeFile(temp, data, encoding, function(err) {
            if (err)
                return callback(err);
            
            _self.exec("writeFile", "put " + temp + " " + filename, function(lines) {
                Fs.unlink(temp, function() {
                    var err = isError(lines);
                    if (err)
                        return callback(err);
                    callback();
                });
            });
        });
    };
    
    this.exec = function(type, cmd, cbexec, cbprogress) {
        var conn = this.state & Sftp.STATE_CONNECTED;
        if (this.activeCmd || !conn) {
            if (!conn)
                this.connect();
            return this.queue.push([type, cmd, cbprogress, cbexec]);
        }
        
        send.call(this, type, cmd, cbexec, cbprogress || K);
    };
    
    function send(type, cmd, cbsend, cbprogress) {
        this.activeCmd = type;
        this.activeCmdBuffer = "";
        if (cbprogress && cbsend) {
            this.callbacks[type] = cbsend;
            this.callbacks[type + "_progress"] = cbprogress;
        }
        this.socket.write(new Buffer(cmd + "\r\n"));
        this.socket.resume();
    }
    
    function parseReply(data, origin) {
        //if (origin === 1)
        //    console.log("data: ", data, data.split("\n").length + " parts");
        this.emit("data", data);
        if (!this.activeCmd && !(this.state & Sftp.STATE_CONNECTING))
            return;
        var cbdone, cbprogress;
        if (data.indexOf("sftp>") > -1 || (this.activeCmd == "bye" && data.indexOf("bye") > -1)) {
            if (this.state & Sftp.STATE_CONNECTING && this.callbacks["connect"]) {
                this.callbacks["connect"]();
                delete this.callbacks["connect"];
            }
            // check if a command has finished executing:
            else if (cbdone = this.callbacks[this.activeCmd]) {
                delete this.callbacks[this.activeCmd];
                delete this.callbacks[this.activeCmd + "_progress"];
                this.activeCmd = null;
                if (origin == 2 && data.indexOf("debug") > -1) {
                    //console.log("STDERR:", data);
                    return;
                }
                cbdone((this.activeCmdBuffer + data).split(/[\n\r]+/).filter(function(line) {
                    return line.indexOf("sftp>") === -1;
                }));
                this.activeCmdBuffer = "";
            }
            if (!this.activeCmd && this.queue.length && this.state & Sftp.STATE_CONNECTED)
                this.exec.apply(this, this.queue.shift());
        }
        else if (cbprogress = this.callbacks[this.activeCmd + "_progress"]) {
            this.activeCmdBuffer += data;
            cbprogress(data);
        }
    }
    
    function isError(lines) {
        var err = null;
        lines.forEach(function(line) {
            if (line.indexOf("No such file or directory") > -1)
                err = line;
        });
        return err;
    }
}).call(Sftp.prototype);

module.exports = Sftp;
