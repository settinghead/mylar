// connection, if given, is a LivedataClient or LivedataServer
// XXX presently there is no way to destroy/clean up a Collection

/* MeteorEnc: Each field names f gets extra fields: f_enc, f_sig,
   and optionally f_mk for search.
   The field f contains plaintext and is not sent to the server
   unless ENC_DEBUG is true */

var debug = false;

// if true, an unencrypted copy of the fields
// will be kept for debugging mode
var ENC_DEBUG = false;

set_enc_debug = function (flag) {
    ENC_DEBUG = flag;
};


enc_field_name = function(f) {
    return f + "_enc";
}
sig_field_name = function(f) {
    return f + "_sig";
}

search_field_name = function(f) {
    return f + "_mk";
}

rand_field_name = function(f) {
    return f + "_rand";
}

Meteor.Collection = function (name, options) {
  var self = this;
  if (! (self instanceof Meteor.Collection))
    throw new Error('use "new" to construct a Meteor.Collection');
  if (options && options.methods) {
    // Backwards compatibility hack with original signature (which passed
    // "connection" directly instead of in options. (Connections must have a "methods"
    // method.)
    // XXX remove before 1.0
    options = {connection: options};
  }
  // Backwards compatibility: "connection" used to be called "manager".
  if (options && options.manager && !options.connection) {
    options.connection = options.manager;
  }
  options = _.extend({
    connection: undefined,
    idGeneration: 'STRING',
    transform: null,
    _driver: undefined,
    _preventAutopublish: false
  }, options);

  switch (options.idGeneration) {
  case 'MONGO':
    self._makeNewID = function () {
      return new Meteor.Collection.ObjectID();
    };
    break;
  case 'STRING':
  default:
    self._makeNewID = function () {
      return Random.id();
    };
    break;
  }

  if (options.transform)
    self._transform = Deps._makeNonreactive(options.transform);
  else
    self._transform = null;

  if (!name && (name !== null)) {
    Meteor._debug("Warning: creating anonymous collection. It will not be " +
                  "saved or synchronized over the network. (Pass null for " +
                  "the collection name to turn off this warning.)");
  }

  // note: nameless collections never have a connection
  self._connection = name && (options.connection ||
                           (Meteor.isClient ?
                            Meteor.default_connection : Meteor.default_server));

  if (!options._driver) {
    if (name && self._connection === Meteor.default_server &&
        Meteor._RemoteCollectionDriver)
      options._driver = Meteor._RemoteCollectionDriver;
    else
      options._driver = Meteor._LocalCollectionDriver;
  }

  self._collection = options._driver.open(name);
  self._name = name;
  self._decrypt_cb = [];   // callbacks for running decryptions
  self._enc_fields = {};
    self._signed_fields = {};

  if (name && self._connection.registerStore) {
    // OK, we're going to be a slave, replicating some remote
    // database, except possibly with some temporary divergence while
    // we have unacknowledged RPC's.
    var ok = self._connection.registerStore(name, {
      // Called at the beginning of a batch of updates. batchSize is the number
      // of update calls to expect.
      //
      // XXX This interface is pretty janky. reset probably ought to go back to
      // being its own function, and callers shouldn't have to calculate
      // batchSize. The optimization of not calling pause/remove should be
      // delayed until later: the first call to update() should buffer its
      // message, and then we can either directly apply it at endUpdate time if
      // it was the only update, or do pauseObservers/apply/apply at the next
      // update() if there's another one.
      beginUpdate: function (batchSize, reset) {
        // pause observers so users don't see flicker when updating several
        // objects at once (including the post-reconnect reset-and-reapply
        // stage), and so that a re-sorting of a query can take advantage of the
        // full _diffQuery moved calculation instead of applying change one at a
        // time.
        if (batchSize > 1 || reset)
          self._collection.pauseObservers();

        if (reset)
          self._collection.remove({});
      },

      // Apply an update.
      // XXX better specify this interface (not in terms of a wire message)?
      update: function (msg) {
        var mongoId = Meteor.idParse(msg.id);
        var doc = self._collection.findOne(mongoId);

        //  console.log("msg: " + JSON.stringify(msg) );
	//  console.log("doc: " + JSON.stringify(doc));
        // Is this a "replace the whole doc" message coming from the quiescence
        // of method writes to an object? (Note that 'undefined' is a valid
        // value meaning "remove it".)
          if (msg.msg === 'replace') {
              var replace = msg.replace;
              self.dec_msg(replace, function() {
                  if (!replace) {
                      if (doc)
                          self._collection.remove(mongoId);
                  } else if (!doc) {
                      self._collection.insert(replace);
                  } else {
                      // XXX check that replace has no $ ops
                      self._collection.update(mongoId, replace);
                  }
              });
              return;
          } else if (msg.msg === 'added') {
              self.dec_msg(msg.fields, function() {
                  var doc = self._collection.findOne({_id: mongoId});
                  if (doc) {
                      throw new Error("Expected not to find a document already present for an add");
                  }
                  self._collection.insert(_.extend({_id: mongoId}, msg.fields));
              });
          } else if (msg.msg === 'removed') {
              if (!doc) {
		  throw new Error("Expected to find a document already present for removed");
	      }
          self._collection.remove(mongoId);
        } else if (msg.msg === 'changed') {
          if (!doc)
            throw new Error("Expected to find a document to change");
          if (!_.isEmpty(msg.fields)) {
            var modifier = {};
            _.each(msg.fields, function (value, key) {
              if (value === undefined) {
                if (!modifier.$unset)
                  modifier.$unset = {};
                modifier.$unset[key] = 1;
              } else {
                  if (!modifier.$set)
                      modifier.$set = {};
                  modifier.$set[key] = value;
              }
            });
	      //modifier.$set maps keys to values for fields that are newly added to doc in "changed" 
	      // meteor-enc:
              self.dec_msg(modifier.$set, function() {
                  self._collection.update(mongoId, modifier);
              });
          }
        } else {
            throw new Error("I don't know how to deal with this message");
        }
	  
      },
	
	// Called at the end of a batch of updates.
	endUpdate: function () {
            self._collection.resumeObservers();
	},

	// will be run when documents are ready in the local database
	runWhenDecrypted: function (f) {
            var ndecrypts = self._decrypt_cb.length;
            if (ndecrypts == 0) {
		f();
            } else {
		var done = _.after(ndecrypts, f);
		_.each(self._decrypt_cb, function (q) {
		    q.push(done);
		});
            }
	},

      // Called around method stub invocations to capture the original versions
      // of modified documents.
      saveOriginals: function () {
        self._collection.saveOriginals();
      },
      retrieveOriginals: function () {
        return self._collection.retrieveOriginals();
      }
    });

    if (!ok)
      throw new Error("There is already a collection named '" + name + "'");
  }

  self._defineMutationMethods();

    // autopublish
    if (!options._preventAutopublish &&
	self._connection && self._connection.onAutopublish)
	self._connection.onAutopublish(function () {
	    var handler = function () { return self.find(); };
	    self._connection.publish(null, handler, {is_auto: true});
	});
};

///
/// Main collection API
///

// returns a list of keys that show up in both a and b
var intersect = function(a, b) {
    r = [];

    _.each(a, function(f) {
        // XXX: We should split enc_fields() into two functions,
        // and check for exactly one of f and f+"_enc", depending on
        // whether we are trying to encrypt or decrypt a message.
        // A further complication is signed fields -- some of those
        // might be encrypted (so only the _enc version is present),
        // and some of those might be plaintext.
        if (_.has(b, f) || _.has(b, f + "_enc")) {
            r.push(f);
        }
    });

    return r;
};


function enc_fields(enc_fields, signed_fields, container) {
    return intersect(_.union(_.keys(enc_fields), _.keys(signed_fields)), container);
}




// returns a function F, such that F
// looks up the enc and sign principals for the field f
lookup_princ_func = function(f, container) {
    // given a list of annotations, such as self._enc_fields,
    // looks-up the principal in the annotation of field f
    return function(annot, cb) {

	var annotf = annot[f];
	if (!annotf) { // f has no annotation in annot
	    cb(undefined, undefined);
	    return;
	}
	var princ_id = container[annotf['princ']];
	
	if (!princ_id) {
	    cb(undefined, undefined);
	    return;
	}

	Principal._lookupByID(princ_id, function(princ){
		cb(undefined, princ);
	});
    }
    
}

Meteor.Collection.prototype._encrypted_fields = function(lst) {

    if (this._enc_fields && _.isEqual(this._enc_fields, lst)) {//annotations already set
	return; 
    }
    
    // make sure these annotations were not already set
    if (this._enc_fields && !_.isEqual(this._enc_fields,{}) && !_.isEqual(this._enc_fields, lst)) {
	throw new Error("cannot declare different annotations for the same collection");
    }
    

    this._enc_fields = lst;

    _.each(lst, function(val){
	var type = val["princtype"];
	var attr = val["attr"];

	var pt = PrincType.findOne({type: type});
	if (pt == undefined) {
	    PrincType.insert({type: type, searchable: (attr == "SEARCHABLE")});
	} else {
	    if (attr == "SEARCHABLE" && !pt['searchable'] ) {
		PrincType.update({type:type}, {$set: {'searchable' : true}});
	    }	    
	}
    });
} 

/*
  Given container -- an object with key (field name) and value (enc value) 
  fields -- set of field names that are encrypted or signed,
  decrypt their values in container
*/
Meteor.Collection.prototype.dec_fields = function(container, fields, callback) {
    var self = this;
    
    var cb = _.after(fields.length, function() {
        callback();
    });
    
    _.each(fields, function(f) {
	async.map([self._enc_fields, self._signed_fields], lookup_princ_func(f, container),
		  function(err, results) {
		      if (err) {
			  throw new Error("could not find princs");
		      }
		      var dec_princ = results[0];
		      var verif_princ = results[1];
		      
		      if (verif_princ) {
			  if (!verif_princ.verify(container[enc_field_name(f)], container[sig_field_name(f)])) {
			      throw new Error("signature does not verify on field " + f);
			  }
		      }
		      if (dec_princ) {
			  var res  = dec_princ.decrypt(container[enc_field_name(f)]);
			  if (ENC_DEBUG) {
			      if (res != container[f]) {
				  throw new Error ("inconsistency in the value decrypted and plaintext");
			      }
			  } else {
			      container[f] = res;
			  }
			  if (is_searchable(this._enc_fields, f)) {
			      MylarCrypto.is_consistent(dec_princ.keys.mk_key, container[f], container[f+"enc"],
					function(res) {
					    if (!res)
						throw new Error(
						    "search encryption not consistent for "
							+ f + " content " + container[f]);
					    cb();
					});
			      return;
			  } 
		      }
		      cb();
		  });	
    });
}

var is_searchable = function(enc_fields, field) {
    if (!enc_fields) {
	return false;
    }
    var annot = enc_fields[field];
    if (annot && (annot['attr'] == 'SEARCHABLE'
		  || annot['attr'] == 'SEARCHABLE INDEX')) 
	return true;
    else
	return false;
}

is_indexable =  function(enc_fields, field) {
    if (!enc_fields)
	return false;

    var annot = enc_fields[field];
    if (annot && annot['attr'] == 'SEARCHABLE INDEX') 
	return true;
    else
	return false;
}

function insert_in_enc_index(ciph){
    _.each(ciph, function(item) {
	IndexEnc.insert({_id: item});
    });
}

// encrypts & signs a document
// container is a map of key to values 
Meteor.Collection.prototype.enc_row = function(container, callback) {
    var self = this;
    
    if (!self._enc_fields) {
	callback();
	return;
    }

    if (!Meteor.isClient || !container) {
        callback();
        return;
    }

    /* r is the set of fields in this row that we need to encrypt or sign */
    var r = enc_fields(self._enc_fields, self._signed_fields, container);

    if (r.length == 0) {
        callback();
        return;
    }

    // we start timing here because we want time of encryption
    // so we want to average over docs with enc fields
    startTime("ENC");
    var cb = _.after(r.length, function() {
	endTime("ENC");
	callback();
    });

   _.each(r, function(f) {

       async.map([self._enc_fields, self._signed_fields], lookup_princ_func(f, container),
		 function(err, results) {
		     if (err) {
			 throw new Error("could not find princs");
		     }
		     var enc_princ = results[0];
		     var sign_princ = results[1];

		     // encrypt value
		     if (enc_princ) {
			 container[enc_field_name(f)] = enc_princ.sym_encrypt(container[f]);
			 if (sign_princ) {
			     container[sig_field_name(f)] = sign_princ.sign(container[enc_field_name(f)]);
			 }

			 var done_encrypt = function() {
			     if (!ENC_DEBUG) {
				 delete container[f];
			     }
			     cb();
			 }
			 
			 if (is_searchable(self._enc_fields, f)) {
			     console.log("is searchable");
			     var time1 = window.performance.now();
			     MylarCrypto.text_encrypt(enc_princ.keys.mk_key,
						      container[f],
						      function(rand, ciph) {
							  container[search_field_name(f)] = ciph;
							  container[rand_field_name(f)] = rand;
							    var time1a = window.performance.now();
							  if (is_indexable(self._enc_fields, f)) {
							      console.log("inserting in index");
							      insert_in_enc_index(ciph);
							  }
							  var time1b = window.performance.now();
							  var time2 = window.performance.now();
							  console.log("all search takes " + (time2-time1));
							  console.log("indexing search " + (time1b-time1a));
							  done_encrypt();
						      });
			 } else {
			     done_encrypt();
			 }
			 return;
		     }

		     // do not encrypt value
		     if (sign_princ) {
			 container[sig_field_name(f)] = sign_princ.sign(container[f]);
		     }
		     cb();
	      });	
   });
 
}

// container is an object with key (field name), value (enc field value)
Meteor.Collection.prototype.dec_msg = function(container, callback) {
    var self = this;
    
    if (!self._enc_fields || !Meteor.isClient || !container) {
	callback();
	return;
    }

    var r = enc_fields(self._enc_fields, self._signed_fields, container);

    if (r.length > 0) {
	startTime("DECMSG");
	var callback_q = [];
	self._decrypt_cb.push(callback_q);
	callback2 = function () {
	    endTime("DECMSG");
	    if (callback) {
		callback();
	    }
	    self._decrypt_cb = _.without(self._decrypt_cb, callback_q);
	    _.each(callback_q, function (f) {
		f();
	    });
	};

        self.dec_fields(container, r, callback2);
    } else {
        callback && callback();
    }

}

_.extend(Meteor.Collection.prototype, {

  _getFindSelector: function (args) {
    if (args.length == 0)
      return {};
    else
      return args[0];
  },

  _getFindOptions: function (args) {
    var self = this;
    if (args.length < 2) {
      return { transform: self._transform };
    } else {
      return _.extend({
        transform: self._transform
      }, args[1]);
    }
  },

  find: function (/* selector, options */) {
    // Collection.find() (return all docs) behaves differently
    // from Collection.find(undefined) (return 0 docs).  so be
    // careful about the length of arguments.
    var self = this;
    var argArray = _.toArray(arguments);
    return self._collection.find(self._getFindSelector(argArray),
                                 self._getFindOptions(argArray));
  },

  findOne: function (/* selector, options */) {
    var self = this;
    var argArray = _.toArray(arguments);
    return self._collection.findOne(self._getFindSelector(argArray),
                                    self._getFindOptions(argArray));
  }

});


// protect against dangerous selectors.  falsey and {_id: falsey} are both
// likely programmer error, and not what you want, particularly for destructive
// operations.  JS regexps don't serialize over DDP but can be trivially
// replaced by $regex.
Meteor.Collection._rewriteSelector = function (selector) {
  // shorthand -- scalars match _id
  if (LocalCollection._selectorIsId(selector))
    selector = {_id: selector};

  if (!selector || (('_id' in selector) && !selector._id))
    // can't match anything
    return {_id: Random.id()};

  var ret = {};
  _.each(selector, function (value, key) {
    if (value instanceof RegExp) {
      // XXX should also do this translation at lower levels (eg if the outer
      // level is $and/$or/$nor, or if there's an $elemMatch)
      ret[key] = {$regex: value.source};
      var regexOptions = '';
      // JS RegExp objects support 'i', 'm', and 'g'. Mongo regex $options
      // support 'i', 'm', 'x', and 's'. So we support 'i' and 'm' here.
      if (value.ignoreCase)
        regexOptions += 'i';
      if (value.multiline)
        regexOptions += 'm';
      if (regexOptions)
        ret[key].$options = regexOptions;
    }
    else
      ret[key] = value;
  });
  return ret;
};

var throwIfSelectorIsNotId = function (selector, methodName) {
  if (!LocalCollection._selectorIsIdPerhapsAsObject(selector)) {
    throw new Meteor.Error(
      403, "Not permitted. Untrusted code may only " + methodName +
        " documents by ID.");
  }
};

// 'insert' immediately returns the inserted document's new _id.  The
// others return nothing.
//
// Otherwise, the semantics are exactly like other methods: they take
// a callback as an optional last argument; if no callback is
// provided, they block until the operation is complete, and throw an
// exception if it fails; if a callback is provided, then they don't
// necessarily block, and they call the callback when they finish with
// error and result arguments.  (The insert method provides the
// document ID as its result; update and remove don't provide a result.)
//
// On the client, blocking is impossible, so if a callback
// isn't provided, they just return immediately and any error
// information is lost.
//
// There's one more tweak. On the client, if you don't provide a
// callback, then if there is an error, a message will be logged with
// Meteor._debug.
//
// The intent (though this is actually determined by the underlying
// drivers) is that the operations should be done synchronously, not
// generating their result until the database has acknowledged
// them. In the future maybe we should provide a flag to turn this
// off.
_.each(["insert", "update", "remove"], function (name) {
  Meteor.Collection.prototype[name] = function (/* arguments */) {
    var self = this;
    var args = _.toArray(arguments);
    var callback;
    var ret;

    //console.log("collection method: " + name + " args= " + args);

    if (args.length && args[args.length - 1] instanceof Function)
      callback = args.pop();

    if (Meteor.isClient && !callback) {
      // Client can't block, so it can't report errors by exception,
      // only by callback. If they forget the callback, give them a
      // default one that logs the error, so they aren't totally
      // baffled if their writes don't work because their database is
      // down.
      callback = function (err) {
        if (err)
          Meteor._debug(name + " failed: " + (err.reason || err.stack));
      };
    }

      // function used as callback
      var f = function() {
          if (self._connection && self._connection !== Meteor.default_server) {
              // just remote to another endpoint, propagate return value or
              // exception.

              var enclosing = Meteor._CurrentInvocation.get();
              var alreadyInSimulation = enclosing && enclosing.isSimulation;
              if (!alreadyInSimulation && name !== "insert") {
                  // If we're about to actually send an RPC, we should throw an error if
                  // this is a non-ID selector, because the mutation methods only allow
                  // single-ID selectors. (If we don't throw here, we'll see flicker.)
                  throwIfSelectorIsNotId(args[0], name);
              }

              if (callback) {
                  // asynchronous: on success, callback should return ret
                  // (document ID for insert, undefined for update and
                  // remove), not the method's result.
                  self._connection.apply(self._prefix + name, args, function (error, result) {
                      callback(error, !error && ret);
                  });
              } else {
                  // synchronous: propagate exception
                  self._connection.apply(self._prefix + name, args);
              }

          } else {
              // it's my collection.  descend into the collection object
              // and propagate any exception.
              try {
                  self._collection[name].apply(self._collection, args);
              } catch (e) {
                  if (callback) {
                      callback(e);
                      return null;
                  }
                  throw e;
              }

              // on success, return *ret*, not the manager's return value.
              callback && callback(null, ret);
          }
      };
    
    if (name === "insert") {
      if (!args.length)
        throw new Error("insert requires an argument");
      // shallow-copy the document and generate an ID
      args[0] = _.extend({}, args[0]);
      if ('_id' in args[0]) {
        ret = args[0]._id;
        if (!(typeof ret === 'string'
              || ret instanceof Meteor.Collection.ObjectID))
          throw new Error("Meteor requires document _id fields to be strings or ObjectIDs");
      } else {
        ret = args[0]._id = self._makeNewID();
      }
        self.enc_row(args[0], f);
    } else {
      args[0] = Meteor.Collection._rewriteSelector(args[0]);
    }

      if (name == "update") {
          // Does set have a principal argument necessary for encryption?
          // XXX handle only updates, not push
          if (args.length > 2) self.enc_row(args[1]['$set'], f)
          else self.enc_row(args[1]['$set'], f)
      }

      if (name == "remove") {
          f();
      }

    // both sync and async, unless we threw an exception, return ret
    // (new document ID for insert, undefined otherwise).
    return ret;
  };
});

// We'll actually design an index API later. For now, we just pass through to
// Mongo's, but make it synchronous.
Meteor.Collection.prototype._ensureIndex = function (index, options) {
  var self = this;
  if (!self._collection._ensureIndex)
    throw new Error("Can only call _ensureIndex on server collections");
  self._collection._ensureIndex(index, options);
};
Meteor.Collection.prototype._dropIndex = function (index) {
  var self = this;
  if (!self._collection._dropIndex)
    throw new Error("Can only call _dropIndex on server collections");
  self._collection._dropIndex(index);
};

Meteor.Collection.ObjectID = LocalCollection._ObjectID;

///
/// Remote methods and access control.
///

// Restrict default mutators on collection. allow() and deny() take the
// same options:
//
// options.insert {Function(userId, doc)}
//   return true to allow/deny adding this document
//
// options.update {Function(userId, docs, fields, modifier)}
//   return true to allow/deny updating these documents.
//   `fields` is passed as an array of fields that are to be modified
//
// options.remove {Function(userId, docs)}
//   return true to allow/deny removing these documents
//
// options.fetch {Array}
//   Fields to fetch for these validators. If any call to allow or deny
//   does not have this option then all fields are loaded.
//
// allow and deny can be called multiple times. The validators are
// evaluated as follows:
// - If neither deny() nor allow() has been called on the collection,
//   then the request is allowed if and only if the "insecure" smart
//   package is in use.
// - Otherwise, if any deny() function returns true, the request is denied.
// - Otherwise, if any allow() function returns true, the request is allowed.
// - Otherwise, the request is denied.
//
// Meteor may call your deny() and allow() functions in any order, and may not
// call all of them if it is able to make a decision without calling them all
// (so don't include side effects).

(function () {
  var addValidator = function(allowOrDeny, options) {
    // validate keys
    var VALID_KEYS = ['insert', 'update', 'remove', 'fetch', 'transform'];
    _.each(_.keys(options), function (key) {
      if (!_.contains(VALID_KEYS, key))
        throw new Error(allowOrDeny + ": Invalid key: " + key);
    });

    var self = this;
    self._restricted = true;

    _.each(['insert', 'update', 'remove'], function (name) {
      if (options[name]) {
        if (!(options[name] instanceof Function)) {
          throw new Error(allowOrDeny + ": Value for `" + name + "` must be a function");
        }
        if (self._transform)
          options[name].transform = self._transform;
        if (options.transform)
          options[name].transform = Deps._makeNonreactive(options.transform);
        self._validators[name][allowOrDeny].push(options[name]);
      }
    });

    // Only update the fetch fields if we're passed things that affect
    // fetching. This way allow({}) and allow({insert: f}) don't result in
    // setting fetchAllFields
    if (options.update || options.remove || options.fetch) {
      if (options.fetch && !(options.fetch instanceof Array)) {
        throw new Error(allowOrDeny + ": Value for `fetch` must be an array");
      }
      self._updateFetch(options.fetch);
    }
  };

  Meteor.Collection.prototype.allow = function(options) {
    addValidator.call(this, 'allow', options);
  };
  Meteor.Collection.prototype.deny = function(options) {
    addValidator.call(this, 'deny', options);
  };
})();


Meteor.Collection.prototype._defineMutationMethods = function() {
  var self = this;

  // set to true once we call any allow or deny methods. If true, use
  // allow/deny semantics. If false, use insecure mode semantics.
  self._restricted = false;

  // Insecure mode (default to allowing writes). Defaults to 'undefined'
  // which means use the global Meteor.Collection.insecure.  This
  // property can be overriden by tests or packages wishing to change
  // insecure mode behavior of their collections.
  self._insecure = undefined;

  self._validators = {
    insert: {allow: [], deny: []},
    update: {allow: [], deny: []},
    remove: {allow: [], deny: []},
    fetch: [],
    fetchAllFields: false
  };

  if (!self._name)
    return; // anonymous collection

  // XXX Think about method namespacing. Maybe methods should be
  // "Meteor:Mongo:insert/NAME"?
  self._prefix = '/' + self._name + '/';

  // mutation methods
  if (self._connection) {
    var m = {};

    _.each(['insert', 'update', 'remove'], function (method) {
      m[self._prefix + method] = function (/* ... */) {
        // All the methods do their own validation, instead of using check().
        check(arguments, [Match.Any]);
        try {
          if (this.isSimulation) {

            // In a client simulation, you can do any mutation (even with a
            // complex selector).
            self._collection[method].apply(
              self._collection, _.toArray(arguments));
            return;
          }

          // This is the server receiving a method call from the client. We
          // don't allow arbitrary selectors in mutations from the client: only
          // single-ID selectors.
          if (method !== 'insert')
            throwIfSelectorIsNotId(arguments[0], method);

          if (self._restricted) {
            // short circuit if there is no way it will pass.
            if (self._validators[method].allow.length === 0) {
              throw new Meteor.Error(
                403, "Access denied. No allow validators set on restricted " +
                  "collection for method '" + method + "'.");
            }

            var validatedMethodName =
                  '_validated' + method.charAt(0).toUpperCase() + method.slice(1);
            var argsWithUserId = [this.userId].concat(_.toArray(arguments));
            self[validatedMethodName].apply(self, argsWithUserId);
          } else if (self._isInsecure()) {
            // In insecure mode, allow any mutation (with a simple selector).
            self._collection[method].apply(
              self._collection, _.toArray(arguments));
          } else {
            // In secure mode, if we haven't called allow or deny, then nothing
            // is permitted.
            throw new Meteor.Error(403, "Access denied");
          }
        } catch (e) {
          if (e.name === 'MongoError' || e.name === 'MinimongoError') {
            throw new Meteor.Error(409, e.toString());
          } else {
            throw e;
          }
        }
      };
    });
    // Minimongo on the server gets no stubs; instead, by default
    // it wait()s until its result is ready, yielding.
    // This matches the behavior of macromongo on the server better.
    if (Meteor.isClient || self._connection === Meteor.default_server)
      self._connection.methods(m);
  }
};


Meteor.Collection.prototype._updateFetch = function (fields) {
  var self = this;

  if (!self._validators.fetchAllFields) {
    if (fields) {
      self._validators.fetch = _.union(self._validators.fetch, fields);
    } else {
      self._validators.fetchAllFields = true;
      // clear fetch just to make sure we don't accidentally read it
      self._validators.fetch = null;
    }
  }
};

Meteor.Collection.prototype._isInsecure = function () {
  var self = this;
  if (self._insecure === undefined)
    return Meteor.Collection.insecure;
  return self._insecure;
};

var docToValidate = function (validator, doc) {
  var ret = doc;
  if (validator.transform)
    ret = validator.transform(EJSON.clone(doc));
  return ret;
};

Meteor.Collection.prototype._validatedInsert = function(userId, doc) {
  var self = this;

  // call user validators.
  // Any deny returns true means denied.
  if (_.any(self._validators.insert.deny, function(validator) {
    return validator(userId, docToValidate(validator, doc));
  })) {
    throw new Meteor.Error(403, "Access denied");
  }
  // Any allow returns true means proceed. Throw error if they all fail.
  if (_.all(self._validators.insert.allow, function(validator) {
    return !validator(userId, docToValidate(validator, doc));
  })) {
    throw new Meteor.Error(403, "Access denied");
  }

  self._collection.insert.call(self._collection, doc);
};

var transformDoc = function (validator, doc) {
  if (validator.transform)
    return validator.transform(doc);
  return doc;
};

// Simulate a mongo `update` operation while validating that the access
// control rules set by calls to `allow/deny` are satisfied. If all
// pass, rewrite the mongo operation to use $in to set the list of
// document ids to change ##ValidatedChange
Meteor.Collection.prototype._validatedUpdate = function(
    userId, selector, mutator, options) {
  var self = this;

  if (!LocalCollection._selectorIsIdPerhapsAsObject(selector))
    throw new Error("validated update should be of a single ID");

  // compute modified fields
  var fields = [];
  _.each(mutator, function (params, op) {
    if (op.charAt(0) !== '$') {
      throw new Meteor.Error(
        403, "Access denied. In a restricted collection you can only update documents, not replace them. Use a Mongo update operator, such as '$set'.");
    } else if (!_.has(ALLOWED_UPDATE_OPERATIONS, op)) {
      throw new Meteor.Error(
        403, "Access denied. Operator " + op + " not allowed in a restricted collection.");
    } else {
      _.each(_.keys(params), function (field) {
        // treat dotted fields as if they are replacing their
        // top-level part
        if (field.indexOf('.') !== -1)
          field = field.substring(0, field.indexOf('.'));

        // record the field we are trying to change
        if (!_.contains(fields, field))
          fields.push(field);
      });
    }
  });

  var findOptions = {transform: null};
  if (!self._validators.fetchAllFields) {
    findOptions.fields = {};
    _.each(self._validators.fetch, function(fieldName) {
      findOptions.fields[fieldName] = 1;
    });
  }

  var doc = self._collection.findOne(selector, findOptions);
  if (!doc)  // none satisfied!
    return;

  var factoriedDoc;

  // call user validators.
  // Any deny returns true means denied.
  if (_.any(self._validators.update.deny, function(validator) {
    if (!factoriedDoc)
      factoriedDoc = transformDoc(validator, doc);
    return validator(userId,
                     factoriedDoc,
                     fields,
                     mutator);
  })) {
    throw new Meteor.Error(403, "Access denied");
  }
  // Any allow returns true means proceed. Throw error if they all fail.
  if (_.all(self._validators.update.allow, function(validator) {
    if (!factoriedDoc)
      factoriedDoc = transformDoc(validator, doc);
    return !validator(userId,
                      factoriedDoc,
                      fields,
                      mutator);
  })) {
    throw new Meteor.Error(403, "Access denied");
  }

  // Back when we supported arbitrary client-provided selectors, we actually
  // rewrote the selector to include an _id clause before passing to Mongo to
  // avoid races, but since selector is guaranteed to already just be an ID, we
  // don't have to any more.

  self._collection.update.call(
    self._collection, selector, mutator, options);
};

// Only allow these operations in validated updates. Specifically
// whitelist operations, rather than blacklist, so new complex
// operations that are added aren't automatically allowed. A complex
// operation is one that does more than just modify its target
// field. For now this contains all update operations except '$rename'.
// http://docs.mongodb.org/manual/reference/operators/#update
var ALLOWED_UPDATE_OPERATIONS = {
  $inc:1, $set:1, $unset:1, $addToSet:1, $pop:1, $pullAll:1, $pull:1,
  $pushAll:1, $push:1, $bit:1
};

// Simulate a mongo `remove` operation while validating access control
// rules. See #ValidatedChange
Meteor.Collection.prototype._validatedRemove = function(userId, selector) {
  var self = this;

  var findOptions = {transform: null};
  if (!self._validators.fetchAllFields) {
    findOptions.fields = {};
    _.each(self._validators.fetch, function(fieldName) {
      findOptions.fields[fieldName] = 1;
    });
  }

  var doc = self._collection.findOne(selector, findOptions);
  if (!doc)
    return;

  // call user validators.
  // Any deny returns true means denied.
  if (_.any(self._validators.remove.deny, function(validator) {
    return validator(userId, transformDoc(validator, doc));
  })) {
    throw new Meteor.Error(403, "Access denied");
  }
  // Any allow returns true means proceed. Throw error if they all fail.
  if (_.all(self._validators.remove.allow, function(validator) {
    return !validator(userId, transformDoc(validator, doc));
  })) {
    throw new Meteor.Error(403, "Access denied");
  }

  // Back when we supported arbitrary client-provided selectors, we actually
  // rewrote the selector to {_id: {$in: [ids that we found]}} before passing to
  // Mongo to avoid races, but since selector is guaranteed to already just be
  // an ID, we don't have to any more.

  self._collection.remove.call(self._collection, selector);
};
