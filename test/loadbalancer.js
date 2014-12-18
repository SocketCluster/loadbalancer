var LoadBalancer = require('../loadbalancer');
var assert = require('assert');

var balancer;

describe('LoadBalancer test', function () {

  beforeEach("Create LoadBalancer before start", function (done) {
    balancer = new LoadBalancer({
      targetDeactivationDuration: 1000,
      targets: [
        {
          "host": "localhost",
          "port": 8000
        },
        {
          "host": "localhost",
          "port": 8100
        }
      ]
    });
    done();
  });

  describe('balancer#deactivateTarget', function () {
    it('should remove target from activeTargets array', function (done) {
      balancer.deactivateTarget('localhost', 8100);
      var expectedTargets = [
        {host: 'localhost', port: 8000}
      ];
      assert.equal(JSON.stringify(balancer.activeTargets), JSON.stringify(expectedTargets));
      done();
    });
  });

  describe('balancer#deactivateTarget - Reactivate', function () {
    it('should reactivate target after targetDeactivationDuration has elapsed', function (done) {
      balancer.deactivateTarget('localhost', 8100);
    
      setTimeout(function () {
        var expectedTargets = [
          {host: 'localhost', port: 8000},
          {host: 'localhost', port: 8100}
        ];
        assert.equal(JSON.stringify(balancer.activeTargets), JSON.stringify(expectedTargets));
        done();
      }, 1500);
    });
  });
  
  
  
});