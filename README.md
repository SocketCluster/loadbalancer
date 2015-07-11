LoadBalancer.js
============

[![Join the chat at https://gitter.im/SocketCluster/loadbalancer](https://badges.gitter.im/Join%20Chat.svg)](https://gitter.im/SocketCluster/loadbalancer?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge&utm_content=badge)

LoadBalancer.js is a sticky-session TCP load balancer which is optimized to work with realtime frameworks (with support for HTTP long polling fallbacks).
It captures raw TCP connections from a specified port and forwards them to various targets (defined as host and port combinations).
It chooses the appropriate target based on a hash of the client's IP address.

LoadBalancer.js was originally designed to work with SocketCluster (http://socketcluster.io) but it can work equally well with any other realtime framework.

Once a client establishes its first successful connection/request with a target, all subsequent 
connections/requests from that client will stick to that same target unless that target crashes or goes offline (or the session times out).

LoadBalancer.js handles target failures transparently. New connections can never fail so long as there is at least one active target -
LoadBalancer.js will automatically rollback connections to bad targets behind the scenes without the client noticing.

Note that because targets are chosen based on each client's IP address, it is possible that a popular IP address could cause many sockets to be routed
to the same target. See http://techcrunch.com/2007/01/01/wikipedia-bans-qatar/.
This is only likely to be a problem if you are using relatively weak target servers that cannot handle more than a few thousand concurrent user.
If your servers are sufficiently beefy, they should be able to handle slightly uneven loads. The beefier your target servers are, the better (so use more cores).
On average, you can expect pretty good distribution between targets.

Note that large targets which have many active clients tend to lose clients as a faster rate than those who have fewer clients (it's a ratio).
Since the incoming steam of clients to each target is a constant, you can expect targets to naturally regain equilibrium some time after an imbalance
(such as one that could arise when a target crashes).

## Install

```bash
npm install -g loadbalancer
```

## Config

To run LoadBalancer.js, you just need to provide it with a config file (use --config some/path/config.json command line argument).
Here is a sample config file showing the most basic options necessary:

```json
{
  "sourcePort": 80,
  "targets": [
    {
      "host": "localhost",
      "port": 8000
    },
    {
      "host": "localhost",
      "port": 8001
    }
  ]
}
```

Here is a sample config file showing all available options:

```json
{
  "sourcePort": 80,
  "balancerCount": 1,
  "targetDeactivationDuration": 60000,
  "sessionExpiry": 30000,
  "downgradeToUser": "someuser", 
  "stickiness": true,
  "balancerControllerPath": "../balancer.js",
  "targets": [
    {
      "host": "localhost",
      "port": 8000
    },
    {
      "host": "localhost",
      "port": 8001
    }
  ]
}
```

#### Options

- **sourcePort** - The port that this load balancer will listen on.
- **balancerCount** - [Optional - Defaults to available number of CPU cores] The number of load balancer processes to spawn.
- **targetDeactivationDuration** - [Optional - Defaults to 60000] How long (in milliseconds) a target will be considered to be inactive after it fails to handle a connection before LoadBalancer will try again.
- **sessionExpiry** - [Optional - Defaults to 30000] How long (in milliseconds) after a client severed all connections to target before expiring the session.
- **downgradeToUser** - [Optional - Defaults to null] If you're launching LoadBalancer.js as root, you may wish to downgrade the permissions after launch for security purposes - This can be a Linux username or UID.
- **stickiness** - [Optional - Defaults to true] Whether or not to use IP-based stickiness (instead of random target selection).
- **balancerControllerPath** - [Optional - Defaults to null] The path to your balancerController script which you can use to block incoming connections before they are processed by LoadBalancer.js.
- **targets** - An array of target servers to forward connections to (LoadBalancer.js will spread the load between them).

## How to run

On Linux, make sure you have root privileges (sudo) - This is necessary if you want to bind to port 80.
You may want to use the downgradeToUser option to downgrade to a different user after launch for extra security.

#### Start
```bash
loadbalancer start --config my/path/config.json
```

#### Stop
```bash
loadbalancer stop
```

## Middleware

LoadBalancer.js does balancing at the TCP layer - This is great for performance and also means that it can work with HTTPS without having to supply it with a certificate.
The downside is that target servers will not be able to see the clients' IP addresses (on a target server; req.connection.remoteAddress will in fact be the 
LoadBalancer's IP address and not the client's) - This means that if you want to do things like block a client based on their IP address, you will have to do it at the load balancer level.
For this purpose, LoadBalancer.js lets you specify a balancerController script which allows you to define middleware which you can use to block incoming 
connections before they are handled by LoadBalancer.js.

Here is what the content of your balancerController script should look like:

```js
module.exports.run = function (balancer) {
  balancer.addMiddleware(balancer.MIDDLEWARE_CONNECTION, function (socket, next) {
    // You can use whatever logic you want in order to decide whether or 
    // not to process this connection
    if (...) {
      // Allow connection to go through
      next();
    } else {
      // Block connection
      next('Blocked connection from client with IP: ' + socket.remoteAddress);
    }
  });
};
```

## License

MIT