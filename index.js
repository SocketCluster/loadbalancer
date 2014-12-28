var LoadBalancer = require('./loadbalancer');
var cluster = require('cluster');
var fs = require('fs');
var argv = require('minimist')(process.argv.slice(2));
var path = require('path');
var os = require('os');

var CLOSE_TIMEOUT = 10000;

if (cluster.isMaster) {
  var configFilePath = argv.config || path.resolve('config.json');
  if (!fs.existsSync(configFilePath)) {
    throw new Error('Could not find a config file at path: ' + configFilePath);
  }
  var config = fs.readFileSync(configFilePath, {encoding: 'utf8'});
  var options = JSON.parse(config);
  
  cluster.schedulingPolicy = options.schedulingPolicy || cluster.SCHED_NONE;

  options.configDir = path.dirname(configFilePath);
  if (options.balancerControllerPath) {
    options.balancerControllerPath = path.resolve(options.configDir, options.balancerControllerPath);
  }
  if (options.balancerCount == null) {
    options.balancerCount = os.cpus().length;
  }
  
  var alive = true;
  var terminatedCount = 0;

  var balancers = [];

  var launchBalancer = function (i) {
    var balancer = cluster.fork();
    balancer.send({
      type: 'init',
      data: options
    });
    
    balancers[i] = balancer;
    
    balancer.on('exit', function () {
      if (alive) {
        launchBalancer(i);
      } else if (++terminatedCount >= balancers.length) {
        process.exit();
      }
    });
  };

  for (var i = 0; i < options.balancerCount; i++) {
    launchBalancer(i);
  }
  
  process.on('SIGTERM', function (m) {
    alive = false;
    for (var i in balancers) {
      balancers[i].send({
        type: 'destroy'
      });
    }
  });
  
} else {
  process.on('message', function (m) {
    var balancer;
    
    if (m.type == 'init') {
      balancer = new LoadBalancer(m.data);

      balancer.on('error', function (err) {
        console.log(err.stack || err.message);
      });
    } else if (m.type == 'destroy') {
      if (balancer) {
        balancer.close(function () {
          process.exit();
        });
      }
      // In case the balancer takes too long to close
      setTimeout(function () {
        process.exit();
      }, CLOSE_TIMEOUT);
    }
  });
}