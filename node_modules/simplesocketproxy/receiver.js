var Receiver = function () {
	this.reset();
};

Receiver.prototype.reset = function () {
	this._data = [];
	this._end = null;
	this._destroy = false;
	this._consumer = null;
};

Receiver.prototype.consume = function (consumer) {
	for (var i in this._data) {
		consumer.write(this._data[i].data, this._data[i].encoding);
	}
	if (this._end) {
		consumer.end(this._end.data, this._end.encoding);
	}
	if (this._destroy) {
		consumer.destroy();
	}
	
	this.reset();
	this._consumer = consumer;
};

Receiver.prototype.write = function (data, encoding) {
	if (this._consumer) {
		this._consumer.write(data, encoding);
	} else {
		this._data.push({data: data, encoding: encoding});
	}
};

Receiver.prototype.end = function (data, encoding) {
	if (this._consumer) {
		this._consumer.end(data, encoding);
	} else {
		this._end = {data: data, encoding: encoding};
	}
};

Receiver.prototype.destroy = function () {
	if (this._consumer) {
		this._consumer.destroy();
		this.reset();
	} else {
		this._destroy = true;
	}
};

module.exports.Receiver = Receiver;