var net = require('net');
var domain = require('domain');
var async = require('async');
var ExpiryManager = require('expirymanager').ExpiryManager;
var EventEmitter = require('events').EventEmitter;

var LoadBalancer = function (options) {
  var self = this;

  this._errorDomain = domain.create();
  this._errorDomain.on('error', function (err) {
    if (!err.message || (err.message != 'read ECONNRESET' && err.message != 'socket hang up')) {
      self.emit('error', err);
    }
  });

  this.MIDDLEWARE_CONNECTION = 'connection';
  
  this._middleware = {};
  this._middleware[this.MIDDLEWARE_CONNECTION] = [];

  this.sourcePort = options.sourcePort;

  this.balancerControllerPath = options.balancerControllerPath;
  this.downgradeToUser = options.downgradeToUser;
  this.targetDeactivationDuration = options.targetDeactivationDuration || 60000;
  this.sessionExpiry = options.sessionExpiry || 30000;
  this.sessionExpiryInterval = options.sessionExpiryInterval || 1000;
  this.maxBufferSize = options.maxBufferSize || 8192;
  this.stickiness = !!options.stickiness;

  this.setTargets(options.targets);

  this._server = net.createServer(this._handleConnection.bind(this));
  this._errorDomain.add(this._server);
  
  this._activeSessions = {};
  this._sessionExpirer = new ExpiryManager();
  
  this._start();
};

LoadBalancer.prototype = Object.create(EventEmitter.prototype);

LoadBalancer.prototype.addMiddleware = function (type, middleware) {
  this._middleware[type].push(middleware);
};

LoadBalancer.prototype._start = function () {
  var self = this;

  if (this.balancerControllerPath) {
    this._errorDomain.run(function () {
      self.balancerController = require(self.balancerControllerPath);
      self.balancerController.run(self);
    });
  }

  this._server.listen(this.sourcePort);
  
  if (this.downgradeToUser && process.setuid) {
    try {
      process.setuid(this.downgradeToUser);
    } catch (err) {
      this._errorDomain.emit('error', new Error('Could not downgrade to user "' + this.downgradeToUser +
      '" - Either this user does not exist or the current process does not have the permission' +
      ' to switch to it.'));
    }
  }

  this._cleanupInterval = setInterval(this._cleanupSessions.bind(this), this.sessionExpiryInterval);
};

LoadBalancer.prototype.close = function (callback) {
  this._server.close(callback);
};

LoadBalancer.prototype.setTargets = function (targets) {
  this.targets = targets;
  this.activeTargets = targets;
  this.activeTargetsLookup = {};
  
  var target;
  for (var i = 0; i < targets.length; i++) {
    target = targets[i];
    this.activeTargetsLookup[target.host + ':' + target.port] = 1;
  }
};

LoadBalancer.prototype.deactivateTarget = function (host, port) {
  var self = this;
  
  var hostAndPort = host + ':' + port;
  
  if (this.activeTargetsLookup[hostAndPort]) {
    var target = {
      host: host,
      port: port
    };
    
    this.activeTargets = this.activeTargets.filter(function (currentTarget) {
      return currentTarget.host != host || currentTarget.port != port;
    });
    
    delete this.activeTargetsLookup[hostAndPort];
    
    // Reactivate after a while
    setTimeout(function () {
      if (!self.activeTargetsLookup[hostAndPort]) {
        self.activeTargets.push(target);
        self.activeTargetsLookup[hostAndPort] = 1;
      }
    }, this.targetDeactivationDuration);
  }
};

LoadBalancer.prototype.isTargetActive = function (host, port) {
  return !!this.activeTargetsLookup[host + ':' + port];
};

LoadBalancer.prototype._hash = function (str, maxValue) {
  var ch;
  var hash = 0;
  if (str == null || str.length == 0) {
    return hash;
  }
  for (var i = 0; i < str.length; i++) {
    ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash;
  }
  return Math.abs(hash) % maxValue;
};

LoadBalancer.prototype._random = function (str, maxValue) {
  return Math.floor(Math.random() * maxValue);
};

LoadBalancer.prototype._chooseTarget = function (sourceSocket) {
  var selectorFunction;
  if (this.stickiness) {
    selectorFunction = this._hash;
  } else {
    selectorFunction = this._random;
  }

  var primaryTargetIndex = selectorFunction.call(this, sourceSocket.remoteAddress, this.targets.length);
  var primaryTarget = this.targets[primaryTargetIndex];
  if (this.activeTargetsLookup[primaryTarget.host + ':' + primaryTarget.port]) {
    return primaryTarget;
  }
  // If the primary target isn't active, we need to choose a secondary one
  var secondaryTargetIndex = selectorFunction.call(this, sourceSocket.remoteAddress, this.activeTargets.length);
  return this.activeTargets[secondaryTargetIndex];
};

LoadBalancer.prototype._connectToTarget = function (sourceSocket, callback, newTargetUri) {
  var self = this;
  
  var remoteAddress = sourceSocket.remoteAddress;
  var activeSession = this._activeSessions[remoteAddress];

  if (newTargetUri !== undefined) {
    activeSession.targetUri = newTargetUri;
  }
  
  // If null, it means that we ran out of targets
  if (activeSession.targetUri == null) {
    callback(new Error('There are no available targets'));
    return;
  }
  
  var currentTargetUri = activeSession.targetUri;
  var targetSocket = net.createConnection(currentTargetUri.port, currentTargetUri.host);
  
  function connectionFailed (err) {
    if (err.code == 'ECONNREFUSED') {
      self.deactivateTarget(currentTargetUri.host, currentTargetUri.port);
      targetSocket.removeListener('error', connectionFailed);
      targetSocket.removeListener('connect', connectionSucceeded);
      
      process.nextTick(function () {
        var latestActiveSession = self._activeSessions[remoteAddress];
        var nextTargetUri;
        
        // If there is still an active session for the current sourceSocket,
        // try to connect to a different target
        if (latestActiveSession) {
          var lastChosenTargetUri = latestActiveSession.targetUri;
          
          // We need to account for asynchronous cases whereby another connection from the
          // same session (same IP address) may have already chosen a new target for the 
          // session - We need both of these connections to settle on the same target
          if (lastChosenTargetUri.host == currentTargetUri.host && 
            lastChosenTargetUri.port == currentTargetUri.port) {
            
            nextTargetUri = self._chooseTarget(sourceSocket);
          } else {
            nextTargetUri = lastChosenTargetUri;
          }
          self._connectToTarget(sourceSocket, callback, nextTargetUri || null);
        }
      });
    } else {
      var errorMessage = err.stack || err.message;
      callback('Target connection failed due to error: ' + errorMessage);
    }
  }
  
  function connectionSucceeded() {
    targetSocket.removeListener('error', connectionFailed);
    targetSocket.removeListener('connect', connectionSucceeded);
    callback(null, targetSocket, currentTargetUri);
  }
  
  targetSocket.on('error', connectionFailed);
  targetSocket.on('connect', connectionSucceeded);
};

LoadBalancer.prototype._verifyConnection = function (sourceSocket, callback) {
  var self = this;
  
  async.applyEachSeries(this._middleware[this.MIDDLEWARE_CONNECTION], sourceSocket,
    function (err) {
      if (err) {
        self.emit('notice', err);
      }
      callback(err, sourceSocket);
    }
  )
};

LoadBalancer.prototype._handleConnection = function (sourceSocket) {
  var self = this;
  var remoteAddress = sourceSocket.remoteAddress;
  
  sourceSocket.on('error', function (err) {
    self._errorDomain.emit('error', err);
  });
  
   if (this._activeSessions[remoteAddress]) {
    this._activeSessions[remoteAddress].clientCount++;
    if (!this.stickiness) {
      this._activeSessions[remoteAddress].targetUri = this._chooseTarget(sourceSocket);
    }
  } else {
    this._activeSessions[remoteAddress] = {
      targetUri: this._chooseTarget(sourceSocket),
      clientCount: 1
    };
  }
  this._sessionExpirer.unexpire([remoteAddress]);
  
  sourceSocket.once('close', function () {
    var freshActiveSession = self._activeSessions[remoteAddress];
    
    if (freshActiveSession) {
      freshActiveSession.clientCount--;
      var freshTargetUri = freshActiveSession.targetUri;
      
      // If freshTargetUri is null, then it means that the LoadBalancer could not
      // establish a connection to any target
      if (freshTargetUri) {
        if (freshActiveSession.clientCount < 1) {
          if (self.isTargetActive(freshTargetUri.host, freshTargetUri.port)) {
            self._sessionExpirer.expire([remoteAddress], Math.round(self.sessionExpiry / 1000));
          } else {
            delete self._activeSessions[remoteAddress];
          }
        }
      } else {
        delete self._activeSessions[remoteAddress];
      }
    }
  });

  this._verifyConnection(sourceSocket, function (err) {
    if (err) {
      self._rejectConnection(sourceSocket, err);
    } else {
      self._acceptConnection(sourceSocket);
    }
  });
};

LoadBalancer.prototype._rejectConnection = function (sourceSocket) {
  sourceSocket.end();
};

LoadBalancer.prototype._acceptConnection = function (sourceSocket) {
  var self = this;
  
  var remoteAddress = sourceSocket.remoteAddress;
  var sourceBuffersLength = 0;
  var sourceBuffers = [];
  
  var bufferSourceData = function (data) {
    sourceBuffersLength += data.length;
    if (sourceBuffersLength > this.maxBufferSize) {
      var errorMessage = 'sourceBuffers for remoteAddress ' + remoteAddress + 
        ' exceeded maxBufferSize of ' + this.maxBufferSize + ' bytes';
        
      self._errorDomain.emit('error', new Error(errorMessage));
    } else {
      sourceBuffers.push(data);
    }
  };
  
  sourceSocket.on('data', bufferSourceData);
  
  self._connectToTarget(sourceSocket, function (err, targetSocket, targetUri) {
    if (err) {
      sourceSocket.end();
      self._errorDomain.emit('error', err);
    } else {
    
      sourceSocket.removeListener('data', bufferSourceData);
      
      targetSocket.on('error', function (err) {
        self.deactivateTarget(targetUri.host, targetUri.port);
        sourceSocket.unpipe(targetSocket);
        targetSocket.unpipe(sourceSocket);
        self._errorDomain.emit('error', err);
      });
      sourceSocket.on('error', function (err) {
        sourceSocket.unpipe(targetSocket);
        targetSocket.unpipe(sourceSocket);
      });
      sourceSocket.once('close', function () {
        targetSocket.end();
      });
      targetSocket.once('close', function () {
        sourceSocket.end();
      });
      
      for (var i = 0; i < sourceBuffers.length; i++) {
        targetSocket.write(sourceBuffers[i]);
      }
      sourceBuffers = [];
      sourceBuffersLength = 0;
      
      sourceSocket.pipe(targetSocket);
      targetSocket.pipe(sourceSocket);
    }
  });
};

LoadBalancer.prototype._cleanupSessions = function () {
  var expiredKeys = this._sessionExpirer.extractExpiredKeys();
  var key;
  
  for (var i = 0; i < expiredKeys.length; i++) {
    key = expiredKeys[i];
    delete this._activeSessions[key];
  }
};

module.exports = LoadBalancer;
