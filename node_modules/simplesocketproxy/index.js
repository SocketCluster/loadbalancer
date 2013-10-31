var http = require('http');
var https = require('https');
var EventEmitter = require('events').EventEmitter;
var Receiver = require('./receiver').Receiver;
var domain = require('domain');

var SimpleSocketProxy = function (options) {
	var self = this;
	
	if (!options) {
		options = {};
	}
	
	this.protocol = options.protocol || 'http';
	
	if (this.protocol == 'https') {
		this._proto = https;
	} else {
		this._proto = http;
	}
	
	this._errorDomain = domain.create();
	this._errorDomain.on('error', function (err) {
		self.emit('error', err);
	});
};

SimpleSocketProxy.prototype = Object.create(EventEmitter.prototype);

SimpleSocketProxy.prototype._getProto = function (req) {
	return req.isSpdy ? 'https' : (req.connection.pair ? 'https' : 'http');
};

SimpleSocketProxy.prototype.proxy = function (req, sourceSocket, dest) {
	var self = this;
	
	this._errorDomain.add(sourceSocket);
	
	sourceSocket.setTimeout(0);
	sourceSocket.setNoDelay(true);
	sourceSocket.setKeepAlive(true);
	
	var receiver = new Receiver();
		
	var onData, onEnd, onClose;
	
	sourceSocket.on('data', onData = function (data, encoding) {
		receiver.write(data, encoding);
	});
	sourceSocket.on('end', onEnd = function (data, encoding) {
		receiver.end(data, encoding);
	});
	sourceSocket.on('close', onClose = function () {
		sourceSocket.removeListener('data', onData);
		sourceSocket.removeListener('end', onEnd);
		sourceSocket.removeListener('close', onClose);
		self._errorDomain.remove(sourceSocket);
		receiver.destroy();
	});
	
	var target = {};
	target.hostname = dest.host;
	target.port = dest.port;
	target.method = 'GET';
	target.path = req.url;
	target.headers = req.headers;
	
	var protocol = this._getProto(req);
	
	if (target.headers['x-forwarded-for']) {
		var addressToAppend = "," + req.connection.remoteAddress || req.socket.remoteAddress;
		target.headers['x-forwarded-for'] += addressToAppend;
	} else {
		target.headers['x-forwarded-for'] = req.connection.remoteAddress || req.socket.remoteAddress;
	}
	if (target.headers['x-forwarded-port']) {
		var portToAppend = "," + req.connection.remotePort || req.socket.remotePort;
		target.headers['x-forwarded-port'] += portToAppend;
	} else {
		target.headers['x-forwarded-port'] = req.connection.remotePort || req.socket.remotePort;
	}
	if (target.headers['x-forwarded-proto']) {
		var protoToAppend = "," + protocol;
		target.headers['x-forwarded-proto'] += protoToAppend;
	} else {
		target.headers['x-forwarded-proto'] = protocol;
	}

	var targetRequest = this._proto.request(target);
	targetRequest.on('error', function (err) {
		self._errorDomain.emit('error', err);
		targetRequest.abort();
		sourceSocket.destroy();
	});
	targetRequest.end();
		
	targetRequest.on('upgrade', function (targetResponse, targetSocket, targetHead) {
		self._errorDomain.add(targetSocket);
		targetSocket.setTimeout(0);
		targetSocket.setNoDelay(true);
		targetSocket.setKeepAlive(true);
		
		var onData, onEnd, onClose;
		
		var headers = [
			'HTTP/1.1 101 Switching Protocols'
		];
		
		for (var i in targetResponse.headers) {
			headers.push(i + ': ' + targetResponse.headers[i]);
		}
		sourceSocket.write(headers.concat(['', '']).join("\r\n"));
		
		receiver.consume(targetSocket);
		
		targetSocket.on('data', onData = function (data, encoding) {
			sourceSocket.write.apply(sourceSocket, arguments);
		});
		targetSocket.on('end', onEnd = function (data, encoding) {
			sourceSocket.end.apply(sourceSocket, arguments);
		});
		targetSocket.on('close', onClose = function () {
			targetSocket.removeListener('data', onData);
			targetSocket.removeListener('end', onEnd);
			targetSocket.removeListener('close', onClose);
			self._errorDomain.remove(targetSocket);
			sourceSocket.destroy();
		});
	});
};

module.exports.SimpleSocketProxy = SimpleSocketProxy;