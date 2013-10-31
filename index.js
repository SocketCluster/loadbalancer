var http = require('http');
var httpProxy = require('http-proxy');
var url = require('url');
var SimpleSocketProxy = require('simplesocketproxy').SimpleSocketProxy;
var domain = require('domain');
var EventEmitter = require('events').EventEmitter;

var LoadBalancer = function (options) {
	var self = this;
	
	this._errorDomain = domain.create();
	this._errorDomain.on('error', function (err) {
		if (err.message && err.message == 'socket hang up') {
			self.emit('notice', err);
		} else {
			self.emit('error', err);
		}
	});
	
	this.protocolOptions = options.protocolOptions;
	this.sourcePort = options.sourcePort;
	this.hostAddress = options.hostAddress;
	
	this.dataKey = options.dataKey;
	this.statusCheckInterval = options.statusCheckInterval || 5000;
	this.checkStatusTimeout = options.checkStatusTimeout || 10000;
	this.statusURL = options.statusURL || '/~status';

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
				port: self.leastBusyPort
			};
		}
		socketProxy.proxy(req, socket, dest);
	});
	
	this.workerStatuses = {};
	this.leastBusyPort = this._randomPort();
	
	if (this.protocolOptions) {
		var proxyOptions = {
			https: this.protocolOptions
		};
		this._server = httpProxy.createServer(proxyHTTP, proxyOptions);
	} else {
		this._server = httpProxy.createServer(proxyHTTP);
	}
	
	this._errorDomain.add(this._server);
	this._server.on('upgrade', proxyWebSocket);
	this._server.listen(this.sourcePort);
};

LoadBalancer.prototype = Object.create(EventEmitter.prototype);

LoadBalancer.prototype.setWorkers = function (workers) {
	this.destPorts = {};
	var i;
	
	for (i in workers) {
		this.destPorts[workers[i].port] = 1;
	}
	this.workers = workers;
	
	setInterval(this._errorDomain.bind(this._updateStatus.bind(this)), this.statusCheckInterval);
};

LoadBalancer.prototype._randomPort = function () {
	var rand = Math.floor(Math.random() * this.workers.length);
	return this.workers[rand].port;
};

LoadBalancer.prototype.calculateLeastBusyPort = function () {
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

LoadBalancer.prototype._updateStatus = function () {
	var self = this;
	var statusesRead = 0;
	var workerCount = this.workers.length;
	
	var body = {
		dataKey: self.dataKey
	};
	
	for (var i in this.workers) {
		(function (worker) {
			var options = {
				hostname: 'localhost',
				port: worker.port,
				method: 'POST',
				path: self.statusURL
			};
			
			var req = http.request(options, function (res) {
				res.setEncoding('utf8');
				var buffers = [];
				
				res.on('data', function (chunk) {
					buffers.push(chunk);
				});
				
				res.on('end', function () {
					var result = Buffer.concat(buffers).toString();
					if (result) {
						try {
							self.workerStatuses[worker.port] = JSON.parse(result);
						} catch (err) {
							self.workerStatuses[worker.port] = null;
						}						
					} else {
						self.workerStatuses[worker.port] = null;
					}
					
					if (++statusesRead >= workerCount) {
						self.calculateLeastBusyPort.call(self);
					}
				});
			});
			
			req.on('socket', function (socket) {
				socket.setTimeout(self.checkStatusTimeout);
				socket.on('timeout', function () {
					req.abort();
				})
			});
			
			req.write(JSON.stringify(body));
			req.end();
		})(this.workers[i]);
	}
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