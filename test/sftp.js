/*
 * @package node-sftp
 * @subpackage test
 * @copyright Copyright (C) 2011 Ajax.org. All rights reserved.
 * @author Mike de Boer <mike AT ajax DOT org>
 * @license Commercial.
 */

var assert = require("assert");
var sftp = require("./../lib/index");
var fs = require("fs");
var path = require("path");

var host = "stage.io";

module.exports = {
    
    timeout: 10000,
    
    setUp : function(next) {
        next();
    },
    
    tearDown : function(next) {
        if (this.obj)
            this.obj.disconnect(next);
        else
            next();
    },
    
    "test connection to localhost": function(next) {
        var obj = this.obj  = new sftp({username: "mike", password: "mike1324"});
        obj.connect(function(err) {
            assert.equal(err, null);
            next();
        });
    },
    
    "test connection to localhost with private key file": function(next) {
        var obj = this.obj  = new sftp({host: host, username: "cloud9", privateKey: "~/.ssh/id_rsa"});
        obj.connect(function(err) {
            assert.equal(err, null);
            next();
        });
    },
    
    "test connection to localhost with private key plain text": function(next) {
        var _self = this;
        fs.readFile("~/.ssh/id_rsa".replace("~", process.env.HOME), "utf8", function(err, data) {
            if (err)
                return next(err);
            var obj = _self.obj = new sftp({host: host, username: "cloud9", privateKey: data});
            obj.connect(function(err) {
                assert.equal(err, null);
                next();
            });
        });
    },
    
    "test sending PWD command to localhost": function(next) {
        var obj = this.obj  = new sftp({host: host, username: "cloud9", privateKey: "~/.ssh/id_rsa"});
        obj.connect(function(err) {
            assert.equal(err, null);
            // exec command:
            obj.pwd(function(err, dir) {
                assert.equal(err, null);
                assert.equal(dir, "/home/cloud9");
                next();
            });
        });
    },
    
    "test sending BYE command to localhost": function(next) {
        var obj = new sftp({host: host, username: "cloud9", privateKey: "~/.ssh/id_rsa"});
        obj.connect(function(err) {
            assert.equal(err, null);
            // exec command:
            obj.disconnect(function(err) {
                assert.equal(err, null);
                next();
            });
        });
    },

    "test sending LS command to localhost": function(next) {
        var obj = this.obj = new sftp({host: host, home: "/home/cloud9", username: "cloud9", privateKey: "~/.ssh/id_rsa"});
        obj.connect(function(err) {
            assert.equal(err, null);
            // exec command:
            obj.ls("c9", function(err, res) {
                assert.equal(err, null);
                assert.equal(res[0].path, "c9/.git");
                next();
            });
        });
    },
    
    "test sending CD command to localhost": function(next) {
        var obj = this.obj  = new sftp({host: host, username: "cloud9", privateKey: "~/.ssh/id_rsa"});
        obj.connect(function(err) {
            assert.equal(err, null);
            // exec command:
            obj.cd("c9/server/c9/db", function(err) {
                assert.equal(err, null);
                // check:
                obj.ls(".", function(err, res) {
                    assert.equal(err, null);
                    assert.equal(res[0].path, "./file.js");
                    next();
                });
            });
        });
    },
    
    // @todo: add tests for chgrp, chmod and chown
    
    "test sending GET command to localhost for non-existing file": function(next) {
        var obj = this.obj = new sftp({host: host, home: "/home/cloud9", username: "cloud9", privateKey: "~/.ssh/id_rsa"});
        var file = "/tmp/testsftpget";
        obj.connect(function(err) {
            assert.equal(err, null);
            // exec command:
            try {
                fs.unlinkSync(file);
            }
            catch (ex) {}
            obj.get(".xxxprofile", file, function(err, res) {
                assert.equal(err, "Couldn't stat remote file: No such file or directory\r\nFile \"/home/cloud9/.xxxprofile\" not found.\r\n");
                assert.equal(res, file);
                assert.ok(!path.existsSync("/tmp/testsftpget"));
                next();
            });
        });
    },
    
    ">test sending GET command to localhost": function(next) {
        var obj = this.obj = new sftp({host: host, home: "/home/cloud9", username: "cloud9", privateKey: "~/.ssh/id_rsa"});
        var file = "/tmp/testsftpget";
        obj.connect(function(err) {
            assert.equal(err, null);
            // exec command:
            try {
                fs.unlinkSync(file);
            }
            catch (ex) {}
            obj.get(".profile", file, function(err, res) {
                assert.equal(err, null);
                assert.equal(res, file);
                assert.ok(path.existsSync("/tmp/testsftpget"));
                fs.unlinkSync(file);
                next();
            });
        });
    }
}

!module.parent && require("./../../async.js/lib/test").testcase(module.exports, "SFTP").exec();
