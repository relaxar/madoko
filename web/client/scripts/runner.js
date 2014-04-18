/*---------------------------------------------------------------------------
  Copyright 2013 Microsoft Corporation.
 
  This is free software; you can redistribute it and/or modify it under the
  terms of the Apache License, Version 2.0. A copy of the License can be
  found in the file "license.txt" at the root of this distribution.
---------------------------------------------------------------------------*/

define(["../scripts/util","../scripts/storage","webmain"],
        function(util,storage,madoko) {

var Runner = (function() {

  function Runner() {
    var self = this;
    
    //self.files = new util.Map();
    self.sendFiles = [];
    self.storage = null;

    self.options = madoko.initialOptions();
    self.options.mathEmbedLimit = 256 * 1024;
    self.madokoWorker = new util.ContWorker("madoko-worker.js"); 
  }

  Runner.prototype.setStorage = function( stg, cont ) {
    var self = this;
    var oldStorage = self.storage;

    self.storage = stg;
    if (self.storage) {
      self.storage.addEventListener("update",self);
      self.storage.forEachFileKind( [storage.File.Text,storage.File.Generated], function(path,content) {
        self.sendFiles.push( { name: path, content: content });
      });
    }

    if (oldStorage) {
      oldStorage.clearEventListener(self);
      self.madokoWorker.postMessage( { type: "clear" }, function(res) { 
        util.message("cleared storage: " + res, util.Msg.Trace);
        cont(null);
      } );
    }
    else {
      cont(null);
    }
  }

  Runner.prototype.handleEvent = function(ev) {
    if (!ev || !ev.type) return;
    var self = this;
    if (ev.type === "update") {
      self.sendFiles.push( { name: ev.file.path, content: ev.file.content });
    }
  }

  Runner.prototype.onMadokoComplete = function(res,ctx,cont) 
  {
    var self = this;
    //console.log( "  update done.");
    if (res.message) {
      util.message(res.message, util.Msg.Tool );
    }
    if (res.err) return cont(res.err, ctx, res.content, false);
    
    //if (res.runOnServer) {
    //  self.serverRun(ctx);
    //}
    if (res.time) {
      util.message("update: " + ctx.round + "\n  time: " + res.time + "ms", util.Msg.Info );
    }

    res.filesReferred.forEach( function(file) {
      if (util.hasImageExt(file)) {
        self.loadImage(ctx.round, file);
      }
    });
    
    util.asyncForEach( res.filesRead, 
      function(file,xcont) {
        self.loadText(ctx.round, file, function(err,content) {
          if (err) util.message("unable to read from storage: " + file, (util.hasTextExt(file) ? util.Msg.Exn : util.Msg.Trace));
          xcont(null,(err ? 0 : 1));
        });
      },
      function(err,filesRead) {
        var readCount = 0;
        if (filesRead) filesRead.forEach( function(n) { readCount += n; });

        var runAgain    = readCount > 0;
        var runOnServer = res.runOnServer && !runAgain 

        if (!runAgain) {
          res.filesWritten.forEach( function(file) {
            util.message(ctx.round.toString() + ": worker generated: " + file.path, util.Msg.Trace );
            self.storage.writeTextFile(file.path,file.content,storage.File.Generated);
            runAgain = true;
            runOnServer = false;
          });
        }

        if (cont) cont(null,ctx,res.content,runAgain,runOnServer);
      }
    );
  }

  Runner.prototype.runMadoko = function(text,ctx,cont) 
  {
    var self = this;
    util.message( "update " + ctx.round + " start", util.Msg.Trace );
    self.madokoWorker.postMessage( {
      type   : "run",
      content: text,
      name   : ctx.docname,
      options: self.options,
      files  : self.sendFiles      
    }, function(res) {
      self.onMadokoComplete(res,ctx,cont);
    });
    self.sendFiles = [];
  }

    

  Runner.prototype.loadImage = function( round, fname ) {
    var self = this;
    if (!self.storage) return;
    self.storage.getImageUrl( fname, function(err,url) {
      if (err) return util.message(err);
      util.message(round.toString() + "storage provided reference: " + fname, util.Msg.Trace);      
      self.options.imginfos = madoko.addImage(self.options.imginfos,fname,url);
    });
  }

  Runner.prototype.loadText = function(round,fname,cont) {
    var self = this;
    if (!self.storage) return;
    self.storage.readTextFile( fname, storage.File.fromPath(fname), function(err,file) {
      if (err) return cont(err,"");
      util.message(round.toString() + ":storage sent: " + fname, util.Msg.Trace);      
      cont(null,file.content);
      //self.files.set(fname,content);
      //self.sendFiles.push({ name: fname, content: content });
    });
  }

  // Called whenever the server needs to run madoko. The server can run:
  // - bibtex: generates a document.bbl file on the server with typeset bibliographies.
  //           for this to work, we need to send over a ".bib" file and potentially
  //           a bibliography style file ".bst".
  // - latex: formulas are typeset using latex. This generates a "document.dimx" file
  //           containing all typeset formulas. For this to work, we may need to 
  //           send extra style files (".sty") or class files (".cls"). 
  Runner.prototype.runMadokoServer = function(text,ctx,cont) {
    var self = this;
    
    // TODO: schedule run on server
    // send: document, and other files (like .bib and include files (but not images))    
    // receive back: document.dimx file (math content) and document.bbl (bibliography)
    var params = {};    
    params.docname = ctx.docname;
    params["/" + params.docname] = text;
    
    if (self.storage) {
      self.storage.forEachFileKind( [storage.File.Text], function(fname,content) {
        params["/" + fname] = content;
      });
    }
    var t0 = Date.now();
    util.requestPOST( "/rest/run", params, function(err,data) {
      if (err) return cont(util.message(err),ctx);
      var time = (Date.now() - t0).toString() + "ms";
      util.message(data.stdout + data.stderr, util.Msg.Tool);
      util.properties(data).forEach(function(name) {
        if (name.substr(0,1) !== "/") return;
        //madoko.writeTextFile( name.substr(1), data[name] );
        var fname   = name.substr(1); 
        var content = data[name];
        util.message("server sent: " + fname, util.Msg.Trace );
        if (self.storage) {
          self.storage.writeTextFile(fname,content,storage.File.Generated);
        }
        else {
          // happens when there is no connection to onedrive etc.
          //self.files.set(fname,content);
          self.sendFiles.push({name:fname, content: content})
        }
      })
      util.message( "server update: " + ctx.round + "\n  time: " + time, util.Msg.Info );
      cont(null,ctx);
    });
  }  

  return Runner;
})();

// module:
return Runner;
});