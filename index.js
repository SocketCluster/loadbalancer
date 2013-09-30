var http = require('http');
var httpProxy = require('http-proxy');
var url = require('url');
var ComSocket = require('ncom').ComSocket;
var SimpleSocketProxy = require('simplesocketproxy').SimpleSocketProxy;
var domain = require('domain');
var EventEmitter = require('events').EventEmitter;

var LoadBalancer = function (options) {
	var self = this;
	
	this._errorDomain = domain.create();
	this._errorDomain.on('error', function (err) {
		self.emit('error', err);
	});
	
	this.protocol = options.protocol || 'http';
	this.protocolOptions = options.protocolOptions;
	this.sourcePort = options.sourcePort;
	this.hostAddress = options.hostAddress;
	
	this.dataKey = options.dataKey;
	this.checkWorkersInterval = 5000;

	this._destRegex = /^([^_]*)_([^_]*)_([^_]*)_/;
	this._sidRegex = /([^A-Za-z0-9]|^)s?sid=([^;]*)/;
	this._hostRegex = /^[^:]*/;
	
	this.setWorkers(options.workers);

	var proxyHTTP = this._errorDomain.bind(function (req, res, proxy) {
		var dest = self._parseDest(req);
		if (dest) {
			if (self.destPorts[dest.port] == null) {
				dest.port = self._randomPort();
			}
		} else {
			dest = {
				host: 'localhost',
				port: self.leastBusyPort
			};
		}
		
		proxy.proxyRequest(req, res, dest);
	});
	
	var socketProxy = new SimpleSocketProxy();
	this._errorDomain.add(socketProxy);

	var proxyWebSocket = this._errorDomain.bind(function (req, socket, head) {
		var dest = self._parseDest(req);
		
		if (dest) {
			if (self.destPorts[dest.port] == null) {
				dest.port = self._randomPort();
			}
		} else {
			dest = {
				host: 'localhost',
				port: self.leastBusyPort,
			};
		}
		socketProxy.proxy(req, socket, dest);
	});
	
	this.workerStatuses = {};
	this.leastBusyPort = this._randomPort();
	
	this._server = httpProxy.createServer(proxyHTTP);
	this._server.on('upgrade', proxyWebSocket);
	
	this._errorDomain.add(this._server);
	
	this._server.listen(this.sourcePort);
};

LoadBalancer.prototype = Object.create(EventEmitter.prototype);

LoadBalancer.prototype.setWorkers = function (workers) {
	this.destPorts = {};
	var i;
	
	for (i in workers) {
		this.destPorts[workers[i].port] = 1;
	}
	for (i in this.workers) {
		if (this.destPorts[this.workers[i].port] == null && this.workers[i].socket) {
			this.workers[i].socket.end();
		}
	}
	this.workers = workers;
	
	this._watchWorkerStatuses();
};

LoadBalancer.prototype._watchWorkerStatuses = function () {
	var self = this;
	var socket, port;
	
	for (i in this.workers) {
		(function (worker) {
			port = worker.port;
			socket = new ComSocket();
			self._errorDomain.add(socket);
			socket.connect(worker.statusPort, 'localhost');
			
			var authMessage = {
				type: 'auth',
				data: self.dataKey
			};
			
			var msg = JSON.stringify(authMessage);
			socket.write(msg);
			socket.on('message', function (message) {
				var data = JSON.parse(message);
				self.workerStatuses[port] = data;
			});

			socket.on('close', function () {
				self._errorDomain.remove(socket);
				self.workerStatuses[port] = null;
			});
			
			worker.socket = socket;
		})(self.workers[i]);
	}
	
	setInterval(this._updateStatus.bind(this), this.checkWorkersInterval);
};

LoadBalancer.prototype._randomPort = function () {
	var rand = Math.floor(Math.random() * this.workers.length);
	return this.workers[rand].port;
};

LoadBalancer.prototype._updateStatus = function () {
	var minBusiness = Infinity;
	var leastBusyPort;
	var httpRPM, ioRPM, clientCount, business;
	
	for (var i in this.workerStatuses) {
		if (this.workerStatuses[i]) {
			clientCount = this.workerStatuses[i].clientCount;
			httpRPM = this.workerStatuses[i].httpRPM;
			ioRPM = this.workerStatuses[i].ioRPM;
		} else {
			clientCount = Infinity;
			httpRPM = Infinity;
			ioRPM = Infinity;
		}
		business = httpRPM + ioRPM + clientCount;
		
		if (business < minBusiness) {
			minBusiness = business;
			leastBusyPort = parseInt(i);
		}
	}
	if (minBusiness == Infinity) {
		leastBusyPort = this._randomPort();
	}
	
	this.leastBusyPort = leastBusyPort;
};

LoadBalancer.prototype._parseDest = function (req) {	
	if (!req.headers || !req.headers.host) {
		return null;
	}

	var urlData = url.parse(req.url);
	var query = urlData.query || '';
	var cookie = '';
	
	if (req.headers && req.headers.cookie) {
		cookie = req.headers.cookie;
	}
	
	if (!query && !cookie) {
		return null;
	}
	
	var matches = query.match(this._sidRegex) || cookie.match(this._sidRegex);
	
	if (!matches) {
		return null;
	}
	
	var routString = matches[2];
	var destMatch = routString.match(this._destRegex);
	
	if (!destMatch) {
		return null;
	}
	
	var host;
	
	if (this.hostAddress) {
		if (this.hostAddress == destMatch[1] || !destMatch[1]) {
			host = 'localhost';
		} else {
			host = destMatch[1];
		}
	} else {
		var targetHostMatch = req.headers.host.match(this._hostRegex);
		if (targetHostMatch) {
			if (targetHostMatch[0] == destMatch[1] || !destMatch[1]) {
				host = 'localhost';
			} else {
				host = destMatch[1];
			}
		} else {
			host = 'localhost';
		}
	}

	var dest = {
		host: host,
		port: parseInt(destMatch[2]) || this.leastBusyPort
	};
	
	return dest;
};

module.exports = LoadBalancer;