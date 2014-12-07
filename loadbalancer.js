var net = require('net');
var domain = require('domain');
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

  this._middleware = {};

  this.sourcePort = options.sourcePort;

  this.balancerControllerPath = options.balancerControllerPath;
  this.downgradeToUser = options.downgradeToUser;
  this.targetDeactivationDuration = options.targetDeactivationDuration || 120000;
  this.sessionExpiry = options.sessionExpiry || 30000;
  this.sessionExpiryInterval = options.sessionExpiryInterval || 1000;
  this.maxBufferSize = options.maxBufferSize || 8192;

  this.setTargets(options.targets);

  this._server = net.createServer(this._handleConnection.bind(this));
  this._errorDomain.add(this._server);
  
  this._activeSessions = {};
  this._sessionExpirer = new ExpiryManager();
  
  this._start();
};

LoadBalancer.prototype = Object.create(EventEmitter.prototype);

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
};

LoadBalancer.prototype.deactivateTarget = function (host, port) {
  var self = this;
  
  var target = {
    host: host,
    port: port
  };
  
  this.activeTargets = this.activeTargets.filter(function (currentTarget) {
    return currentTarget.host != host || currentTarget.port != port;
  });
  
  // Reactivate after a while
  setTimeout(function () {
    self.activeTargets.push(target);
  }, this.targetDeactivationDuration);
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

LoadBalancer.prototype._chooseTarget = function (sourceSocket) {
  var remoteAddress = sourceSocket.remoteAddress;
  var activeSession = this._activeSessions[remoteAddress];
  
  if (activeSession) {
    return activeSession.targetUri;
  }
  
  var targetIndex = this._hash(remoteAddress, this.activeTargets.length);
  return this.activeTargets[targetIndex];
};

LoadBalancer.prototype._connectToTarget = function (sourceSocket, callback) {
  var self = this;
  
  var targetUri = this._chooseTarget(sourceSocket);
  
  if (targetUri == null) {
    callback(new Error('There are no available targets'));
    return;
  }
  
  var targetSocket = net.createConnection(targetUri.port, targetUri.host);
  
  function connectionFailed (err) {
    if (err.code == 'ECONNREFUSED') {
      self.deactivateTarget(targetUri.host, targetUri.port);
      targetSocket.removeListener('error', connectionFailed);
      targetSocket.removeListener('connect', connectionSucceeded);
      
      process.nextTick(function () {
        self._connectToTarget(sourceSocket, callback);
      });
    } else {
      var errorMessage = err.stack || err.message;
      callback('Target connection failed due to error: ' + errorMessage);
    }
  }
  
  function connectionSucceeded() {
    targetSocket.removeListener('error', connectionFailed);
    targetSocket.removeListener('connect', connectionSucceeded);
    callback(null, targetSocket, targetUri);
  }
  
  targetSocket.on('error', connectionFailed);
  targetSocket.on('connect', connectionSucceeded);
};

LoadBalancer.prototype._handleConnection = function (sourceSocket) {
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
      self._errorDomain.emit('error', err);
    } else {
      if (self._activeSessions[remoteAddress]) {
        self._activeSessions[remoteAddress].clientCount++;
      } else {
        self._activeSessions[remoteAddress] = {
          targetUri: targetUri,
          clientCount: 1
        };
        self._sessionExpirer.unexpire([remoteAddress]);
      }
      
      sourceSocket.removeListener('data', bufferSourceData);
      
      targetSocket.on('error', function (err) {
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
        var activeSession = self._activeSessions[remoteAddress];
        activeSession.clientCount--;
        if (activeSession.clientCount < 1) {
          self._sessionExpirer.expire([remoteAddress], self.sessionExpiry);
        }
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
  
  sourceSocket.on('error', function (err) {
    self._errorDomain.emit('error', err);
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
