function DNSRecord(record) {
  this.ts = Date.now();
  var ttl;
  if (record) {
    try {
      this.canonicalName = record.canonicalName;
    } catch(e) {}
    this.entries = [];

    try {
      for (;;) this.entries.push(record.getNextAddrAsString());
    } catch(e) {
      // NS_ERROR_NOT_AVAILABLE, no more records
      // notice that hasMore() internall just calls getNextAttr(), checks for errors and resets the iterator
    }
    ttl = this.TTL;
    if (!this.entries.length) this.valid = false;
  } else {
    this.valid = false;
  }
  if (!this.valid) ttl = this.INVALID_TTL_ASYNC;
  this.expireTime = this.ts + ttl;
}

DNSRecord.prototype = {
  INVALID_TTL_ASYNC: 3000,
  INVALID_TTL_SYNC: 8000,
  TTL: 60000,
  valid: true,
  ts: 0,
  entries: [],
  canonicalName: '',
  expireTime: 0,
  refreshing: false,
  localExtras: null, // AddressMatcher object which can be added to the LOCAL resolution


  isLocal: function(all) {
    return all
      ? "everyLocal" in this
        ? this.everyLocal
        : this.everyLocal = this.entries.every(DNS.isLocalIP, DNS)
      : "someLocal" in this
        ? this.someLocal
        : this.someLocal = this.entries.some(DNS.isLocalIP, DNS)
      ;
  },
  get expired() {
    return Date.now() > this.expireTime;
  }

}


var DNS = {

  get logFile() {
    delete this.logFile;
    var logFile = Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
    logFile.append("noscript_dns.log");
    return this.logFile = logFile;
  },
  logEnabled: false,
  log: function(msg) {
    try {
      if (!this.logStream) {
        const logFile = this.logFile;
        const logStream = Cc["@mozilla.org/network/file-output-stream;1"]
          .createInstance(Ci.nsIFileOutputStream);
        logStream.init(logFile, 0x02 | 0x08 | 0x10, 384 /*0600*/, 0 );
        this.logStream = logStream;
        const header="*** Log start at "+new Date().toGMTString()+"\n";
        this.logStream.write(header,header.length);
      }

      if (msg!=null) {
        msg += "\n";
        this.logStream.write(msg,msg.length);
      }
      this.logStream.flush();
    } catch(ex) {
      dump(ex.message+"\noccurred logging this message:\n"+msg);
    }
  },

  get _dns() {
    delete this._dns;
    return this._dns = Cc["@mozilla.org/network/dns-service;1"]
                  .getService(Ci.nsIDNSService);
  },

  _cache: {
    CAPACITY: 400, // when we purge, we cut this to half
    _map: {__proto__: null},
    _ext: {__proto__: null},
    count: 0,


    get: function(key) {
      return key in this._map && this._map[key];
    },
    put: function(key, entry) {
      if (!(key in this._map)) {
        if (this.count >= this.CAPACITY) {
          this.purge();
        }
      }
      this._map[key] = entry;
      this.count++;
    },
    evict: function(host) {
      return (host in this._map) && (delete this._map[host]);
    },

    purge: function() {
      var max = this.CAPACITY / 2;
      if (this.count < max) return;
      var l = [];
      var map = this._map;
      for (var key in map) {
        l.push({ k: key, t: map[key].ts});
      }
      this._doPurge(map, l, max);
    },

    reset: function() {
      this._map = {__proto__: null};
      this._ext = {__proto__: null},
      this.count = 0;
    },

    _oldLast: function(a, b) {
      return a.t > b.t ? -1 : a.t < b.t ? 1 : 0;
    },

    putExt: function(host) {
      this._ext[host] = true;
    },
    isExt: function(host) {
      return host in this._ext;
    },


    _doPurge: function(map, l, max) {
      l.sort(this._oldLast);
      for (var j = l.length; j-- > max;) {
        delete map[l[j].k];
      }
      this.count -= (l.length - max);
    }
  },

  get idn() {
    delete this.idn;
    return this.idn =  Cc["@mozilla.org/network/idn-service;1"]
      .getService(Ci.nsIIDNService);
  },

  _invalidRx: /[^\w\-\.]/,
  checkHostName: function(host) {
    if (this._invalidRx.test(host) && !this.isIP(host)) {
      try {
        host = this.idn.convertUTF8toACE(host);
      } catch(e) {
        return false;
      }
      return !this._invalidRx.test(host);
    }
    return true;
  },

  _resolving: {},
  resolve: function(host, flags, callback) {
    flags = flags || 0;

    var elapsed = 0, t;
    var cache = this._cache;
    var async = IOUtil.asyncNetworking || !!callback;

    var dnsRecord = cache.get(host);
    if (dnsRecord) {
      // cache invalidation, if needed
      if (dnsRecord.expired && !dnsRecord.refreshing) {
        if (dnsRecord.valid && !(flags & 1)) {
          // refresh async
          dnsRecord.refreshing = true;
          DNS._dns.asyncResolve(host, flags, new DNSListener(function() {
              if (DNS.logEnabled) DNS.log("Async " + host);
              cache.put(host, dnsRecord = new DNSRecord(this.record));
            }), Thread.currentQueue);
        } else {
          flags |= 1;
        }
        if (flags & 1) {
          dnsRecord = null;
          cache.evict(host);
        }
      }
    }
    if (dnsRecord) {
      if (ABE.consoleDump) ABE.log("Using cached DNS record for " + host);
    } else if (this.checkHostName(host)) {

      if (async) {
        var resolving = this._resolving;

        if (host in resolving) {
          ABE.log("Already resolving " + host);

          if (callback) {
            resolving[host].push(callback);
            return null;
          }
        } else resolving[host] = callback ? [callback] : [];

        var ctrl = {
          running: true,
          startTime: Date.now()
        };

        var status = Cr.NS_OK;


        var resolve = function() {
          DNS._dns.asyncResolve(host, flags, new DNSListener(function() {
            if (DNS.logEnabled) DNS.log("Async " + host);
            cache.put(host, dnsRecord = new DNSRecord(this.record));
            ctrl.running = false;
            var callbacks = resolving[host];
            delete resolving[host];
            if (ABE.consoleDump && t) {
              elapsed = Date.now() - t;
              ABE.log("Async DNS query on " + host + " done, " + elapsed + "ms, callbacks: " + (callbacks && callbacks.length));
            }

            if (callbacks && callbacks.length)
              for (var cb  of callbacks)
                cb(dnsRecord);

          }), Thread.currentQueue);
          if (ABE.consoleDump) ABE.log("Waiting for DNS query on " + host);
          if (!callback) Thread.spin(ctrl);
        }

        if (callback) {
          t = Date.now();
          resolve();
          return null;
        }

        resolve();

        if (!Components.isSuccessCode(status)) throw status;

        elapsed = ctrl.elapsed || 0;
      } else {
        t = Date.now();
        if (ABE.consoleDump) ABE.log("Performing DNS query on " + host);
        if (DNS.logEnabled) DNS.log("Sync " + host);
        cache.put(host, dnsRecord = new DNSRecord(this._dns.resolve(host, flags)));
        elapsed = Date.now() - t;
      }
    } else {
      this._cache.put(host, dnsRecord = new DNSRecord(null)); // invalid host name
    }

    if (ABE.consoleDump) ABE.log("DNS query on " + host + " done, " + elapsed + "ms");

    if (callback) {
      callback(dnsRecord);
    } else {
      if (!(dnsRecord && dnsRecord.valid)) throw Cr.NS_ERROR_UNKNOWN_HOST;
    }
    return dnsRecord;
  },



  evict: function(host) {
    ABE.log("Removing DNS cache record for " + host);
    return this._cache.evict(host);
  },

  invalidate: function(host) {
    var dnsRecord = this._cache.get(host);
    if (!dnsRecord.valid) return false;
    dnsRecord.valid = false;
    dnsRecord.expireTime = 0;
    return true;
  },

  getCached: function(host) {
    return this._cache.get(host);
  },

  isCached: function(host) {
    var res =  this._cache.get(host);
    return res && (res.valid || !res.expired);
  },

  isLocalURI: function(uri, all) {
    var host;
    try {
      host = uri.host;
    } catch(e) {
      return false;
    }
    if (!host) return true; // local file:///
    return this.isLocalHost(host, all);
  },

  _localDomainRx: /\.local$/i,
  isLocalHost: function(host, all, dontResolve) {
    if (host === "localhost" || this._localDomainRx.test(host)) return true;
    if (this.isIP(host)) {
      return this.isLocalIP(host);
    }

    if (all && this._cache.isExt(host) || dontResolve) return false;

    var res = this.resolve(host, 0).isLocal(all);

    if (!res) {
      this._cache.putExt(host);
    }

    return res;
  },

  _localIP6Rx: /^(?:::1?$|f(?:[cd]|e[c-f])[0-9a-f]*:)/i,
  get _localIPMatcher() {
    delete this._localIPMatcher;
    return this._localIPMatcher = new AddressMatcher('0. 127. 10. 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 255.255.255.255');
  },
  isLocalIP: function(addr) {
    // see https://bug354493.bugzilla.mozilla.org/attachment.cgi?id=329492 for a more verbose but incomplete (missing IPv6 ULA) implementation
    // Relevant RFCs linked at http://en.wikipedia.org/wiki/Private_network
    // Note: we omit link-local IPv6 addresses (fe80:/10) on purpose, because they're currently found in the wild as misconfigured
    //       AAAA DNS records. The safest work-around is considering them external to the LAN always.

    return this._localIP6Rx.test(addr) ||
      this._localIPMatcher.testIP(addr = this.ip6to4(addr)) ||
      this.localExtras && this.localExtras.testIP(addr) ||
      WAN.ipMatcher && WAN.ipMatcher.testIP(addr);
  },
  _ip6to4Rx: /^2002:([A-F0-9]{2})([A-F0-9]{2}):([A-F0-9]{2})([A-F0-9]{2})|:(?:\d+\.){3}\d+$/i,
  ip6to4: function(addr) {
    let m = addr.match(this._ip6to4Rx);
    return m ? (m[1]
          ? m.slice(1).map((h) => parseInt(h, 16)).join(".")
          : m[0].substring(1)
       )
      : addr;
  },
  _ipRx: /^(?:0\.|[1-9]\d{0,2}\.){3}(?:0|[1-9]\d{0,2})$|:.*:/i, // very restrictive, rejects IPv4 hex, octal and int32
  _ipRx_permissive: /^(?:(?:\d+|0x[a-f0-9]+)\.){0,3}(?:\d+|0x[a-f0-9]+)$|:.*:/i,
  isIP: function(host) { return this._ipRx.test(host); }
};

function DNSListener(callback) {
  if (callback) this.callback = callback;
};
DNSListener.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIDNSListener]),
  record: null,
  status: 0,
  callback: null,
  onLookupComplete: function(req, rec, status) {
    this.record = rec;
    this.status = status;
    if (this.callback) this.callback();
  }
};
