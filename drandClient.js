let c={"0":["/* eslint-env browser */\n\nexport class AbortError extends Error {\n  constructor (message) {\n    super(message || 'The operation was aborted')\n    this.type = 'aborted'\n    this.name = 'AbortError'\n    this.code = 'ABORT_ERR'\n  }\n}\n\nexport function controllerWithParent (parentSignal) {\n  const controller = new AbortController()\n\n  if (parentSignal == null) {\n    return controller\n  }\n\n  if (parentSignal.aborted) {\n    controller.abort()\n    return controller\n  }\n\n  const onAbort = () => {\n    controller.abort()\n    parentSignal.removeEventListener('abort', onAbort)\n  }\n\n  parentSignal.addEventListener('abort', onAbort)\n\n  controller.signal.addEventListener('abort', () => {\n    parentSignal.removeEventListener('abort', onAbort)\n  })\n\n  return controller\n}\n"],"1":["export default class Chain {\n  /**\n   * roundAt determines the round number given a round time, a chain genesis and\n   * a chain period.\n   *\n   * @param time {number} Round time in ms\n   * @param genesis {number} Chain genesis time in ms\n   * @param period {number} Chain period in ms\n   */\n  static roundAt (time, genesis, period) {\n    if (time < genesis) return 1\n    return Math.floor((time - genesis) / period) + 1\n  }\n\n  /**\n   * roundTime determines the time a round should be available, given a chain\n   * genesis and a chain period.\n   *\n   * @param round {number} Round number\n   * @param genesis {number} Chain genesis time in ms\n   * @param period {number} Chain period in ms\n   */\n  static roundTime (round, genesis, period) {\n    round = round < 0 ? 0 : round\n    return genesis + ((round - 1) * period)\n  }\n}\n"],"2":["import { AbortError, controllerWithParent } from /*'./abort.js'*/",{"m":0},"\nimport Chain from /*'./chain.js'*/",{"m":1},"\n\nasync function forNextRound (round, chainInfo, { signal }) {\n  const time = Chain.roundTime(round + 1, chainInfo.genesis_time * 1000, chainInfo.period * 1000)\n  const delta = time - Date.now()\n  if (delta <= 0) return\n  return new Promise((resolve, reject) => {\n    if (signal.aborted) return reject(new AbortError())\n    const timeoutID = setTimeout(() => {\n      signal.removeEventListener('abort', onAbort)\n      resolve()\n    }, delta)\n    const onAbort = () => {\n      clearTimeout(timeoutID)\n      reject(new AbortError())\n    }\n    signal.addEventListener('abort', onAbort)\n  })\n}\n\nexport default class PollingWatcher {\n  constructor (client, chainInfo) {\n    this._client = client\n    this._chainInfo = chainInfo\n    this._controllers = []\n  }\n\n  async * watch (options) {\n    options = options || {}\n\n    const controller = controllerWithParent(options.signal)\n    this._controllers.push(controller)\n\n    try {\n      let round, rand\n      round = this._client.roundAt(Date.now())\n      rand = await this._client.get(round, { signal: controller.signal })\n      yield rand\n\n      while (true) {\n        round = this._client.roundAt(Date.now())\n        await forNextRound(round, this._chainInfo, { signal: controller.signal })\n        rand = await this._client.get(round + 1, { signal: controller.signal })\n        yield rand\n      }\n    } finally {\n      this._controllers = this._controllers.filter(c => c !== controller)\n      controller.abort()\n    }\n  }\n\n  close () {\n    this._controllers.forEach(c => c.abort())\n    this._controllers = []\n  }\n}\n"],"3":["/* eslint-env browser */\n\nimport { controllerWithParent } from /*'./abort.js'*/",{"m":0},"\nimport PollingWatcher from /*'./polling-watcher.js'*/",{"m":2},"\nimport Chain from /*'./chain.js'*/",{"m":1},"\n\nexport default class HTTP {\n  constructor (url, chainInfo, options) {\n    this._url = url\n    this._chainInfo = chainInfo\n    this._options = options || {}\n    this._controllers = []\n    this._watcher = new PollingWatcher(this, chainInfo)\n  }\n\n  async get (round, options) {\n    options = options || {}\n\n    if (typeof round === 'object') {\n      options = round\n      round = 0\n    }\n\n    const controller = controllerWithParent(options.signal)\n    this._controllers.push(controller)\n\n    try {\n      const url = `${this._url}/public/${round || 'latest'}${options.noCache ? '?' + Date.now() : ''}`\n      const res = await fetch(url, { signal: controller.signal })\n      if (!res.ok) throw new Error(`unexpected HTTP status ${res.status} for URL ${url}`)\n      const rand = await res.json()\n      return rand\n    } finally {\n      this._controllers = this._controllers.filter(c => c !== controller)\n      controller.abort()\n    }\n  }\n\n  async info () {\n    return this._chainInfo\n  }\n\n  static async info (url, chainHash, options) {\n    options = options || {}\n    const res = await fetch(`${url}/info${options.noCache ? '?' + Date.now() : ''}`, { signal: options.signal })\n    if (!res.ok) throw new Error(`unexpected HTTP status ${res.status} for URL ${url}/info`)\n    const info = await res.json()\n    if (chainHash && chainHash !== info.hash) {\n      throw new Error(`${url} does not advertise the expected drand group (${info.hash} vs ${chainHash})`)\n    }\n    return info\n  }\n\n  async * watch (options) {\n    yield * this._watcher.watch(options)\n  }\n\n  roundAt (time) {\n    return Chain.roundAt(time, this._chainInfo.genesis_time * 1000, this._chainInfo.period * 1000)\n  }\n\n  async close () {\n    this._controllers.forEach(c => c.abort())\n    this._controllers = []\n    await this._watcher.close()\n  }\n\n  static async forURLs (urls, chainHash) {\n    let chainInfo\n    for (const url of urls) {\n      try {\n        chainInfo = await HTTP.info(url, chainHash)\n        break\n      } catch (err) {\n        if (url === urls[urls.length - 1]) {\n          throw err\n        }\n      }\n    }\n    return urls.map(url => new HTTP(url, chainInfo))\n  }\n}\n"],"4":["/* eslint-env browser */\n\nconst SPEED_TEST_INTERVAL = 1000 * 60 * 5\n\nexport default class Optimizing {\n  // TODO: options for default request timeout and concurrency\n  constructor (clients, options) {\n    this._clients = clients\n    this._stats = clients.map(c => ({ client: c, rtt: 0, startTime: Date.now() }))\n    this._options = options || {}\n    this._options.speedTestInterval = this._options.speedTestInterval || SPEED_TEST_INTERVAL\n  }\n\n  start () {\n    if (this._options.speedTestInterval > 0) {\n      return this._testSpeed()\n    }\n  }\n\n  _testSpeed () {\n    const run = async () => {\n      const stats = await Promise.all(this._clients.map(async c => {\n        try {\n          const res = await this._get(c, 1, { noCache: true })\n          return res.stat\n        } catch (_) {\n          // An abort happened\n        }\n      }))\n      this._updateStats(stats.filter(Boolean))\n    }\n    this._speedTestIntervalID = setInterval(run, this._options.speedTestInterval)\n    return run()\n  }\n\n  _fastestClients () {\n    return this._stats.map(s => s.client)\n  }\n\n  _updateStats (stats) {\n    for (const next of stats) {\n      for (const curr of this._stats) {\n        if (curr.client === next.client) {\n          if (curr.startTime <= next.startTime) {\n            curr.rtt = next.rtt\n            curr.startTime = next.startTime\n          }\n          break\n        }\n      }\n    }\n    this._stats.sort((a, b) => a.rtt - b.rtt)\n  }\n\n  async get (round, options) {\n    const stats = []\n    try {\n      let res\n      // TODO: race with concurrency\n      for (const client of this._fastestClients()) {\n        res = await this._get(client, round, options)\n        stats.push(res.stat)\n        if (!res.error) {\n          return res.rand\n        }\n      }\n      throw res.error\n    } finally {\n      this._updateStats(stats)\n    }\n  }\n\n  // _get performs get on the passed client, recording a request stat. If an\n  // error occurs that is not an abort error then a result will still be\n  // returned with an error property.\n  async _get (client, round, options) {\n    const startTime = Date.now()\n    try {\n      const rand = await client.get(round, options)\n      return { rand, stat: { client, rtt: Date.now() - startTime, startTime } }\n    } catch (err) {\n      // client failure, set a large RTT so it is sent to the back of the list\n      if (err.name !== 'AbortError') {\n        return { error: err, stat: { client, rtt: Number.MAX_SAFE_INTEGER, startTime } }\n      }\n      throw err\n    }\n  }\n\n  async * watch (options) {\n    // TODO: watch and race all clients\n    const client = this._fastestClients()[0]\n    yield * client.watch(options)\n  }\n\n  async info (options) {\n    for (const client of this._clients) {\n      try {\n        const info = await client.info(options)\n        return info\n      } catch (err) {\n        if (client === this._clients[this._clients.length - 1]) {\n          throw err\n        }\n      }\n    }\n  }\n\n  roundAt (time) {\n    return this._clients[0].roundAt(time)\n  }\n\n  async close () {\n    clearInterval(this._speedTestIntervalID)\n    return Promise.all(this._clients.map(c => c.close()))\n  }\n}\n"],"5":["// Copyright 2018 The Go Authors. All rights reserved.\n// Use of this source code is governed by a BSD-style\n// license that can be found in the LICENSE file.\n\n(() => {\n\t// Map multiple JavaScript environments to a single common API,\n\t// preferring web standards over Node.js API.\n\t//\n\t// Environments considered:\n\t// - Browsers\n\t// - Node.js\n\t// - Electron\n\t// - Parcel\n\n\tif (typeof global !== \"undefined\") {\n\t\t// global already exists\n\t} else if (typeof window !== \"undefined\") {\n\t\twindow.global = window;\n\t} else if (typeof self !== \"undefined\") {\n\t\tself.global = self;\n\t} else {\n\t\tthrow new Error(\"cannot export Go (neither global, window nor self is defined)\");\n\t}\n\n\tif (!global.require && typeof require !== \"undefined\") {\n\t\tglobal.require = require;\n\t}\n\n\tif (!global.fs && global.require) {\n\t\tconst fs = require(\"fs\");\n\t\tif (Object.keys(fs).length !== 0) {\n\t\t\tglobal.fs = fs;\n\t\t}\n\t}\n\n\tconst enosys = () => {\n\t\tconst err = new Error(\"not implemented\");\n\t\terr.code = \"ENOSYS\";\n\t\treturn err;\n\t};\n\n\tif (!global.fs) {\n\t\tlet outputBuf = \"\";\n\t\tglobal.fs = {\n\t\t\tconstants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused\n\t\t\twriteSync(fd, buf) {\n\t\t\t\toutputBuf += decoder.decode(buf);\n\t\t\t\tconst nl = outputBuf.lastIndexOf(\"\\n\");\n\t\t\t\tif (nl != -1) {\n\t\t\t\t\tconsole.log(outputBuf.substr(0, nl));\n\t\t\t\t\toutputBuf = outputBuf.substr(nl + 1);\n\t\t\t\t}\n\t\t\t\treturn buf.length;\n\t\t\t},\n\t\t\twrite(fd, buf, offset, length, position, callback) {\n\t\t\t\tif (offset !== 0 || length !== buf.length || position !== null) {\n\t\t\t\t\tcallback(enosys());\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tconst n = this.writeSync(fd, buf);\n\t\t\t\tcallback(null, n);\n\t\t\t},\n\t\t\tchmod(path, mode, callback) { callback(enosys()); },\n\t\t\tchown(path, uid, gid, callback) { callback(enosys()); },\n\t\t\tclose(fd, callback) { callback(enosys()); },\n\t\t\tfchmod(fd, mode, callback) { callback(enosys()); },\n\t\t\tfchown(fd, uid, gid, callback) { callback(enosys()); },\n\t\t\tfstat(fd, callback) { callback(enosys()); },\n\t\t\tfsync(fd, callback) { callback(null); },\n\t\t\tftruncate(fd, length, callback) { callback(enosys()); },\n\t\t\tlchown(path, uid, gid, callback) { callback(enosys()); },\n\t\t\tlink(path, link, callback) { callback(enosys()); },\n\t\t\tlstat(path, callback) { callback(enosys()); },\n\t\t\tmkdir(path, perm, callback) { callback(enosys()); },\n\t\t\topen(path, flags, mode, callback) { callback(enosys()); },\n\t\t\tread(fd, buffer, offset, length, position, callback) { callback(enosys()); },\n\t\t\treaddir(path, callback) { callback(enosys()); },\n\t\t\treadlink(path, callback) { callback(enosys()); },\n\t\t\trename(from, to, callback) { callback(enosys()); },\n\t\t\trmdir(path, callback) { callback(enosys()); },\n\t\t\tstat(path, callback) { callback(enosys()); },\n\t\t\tsymlink(path, link, callback) { callback(enosys()); },\n\t\t\ttruncate(path, length, callback) { callback(enosys()); },\n\t\t\tunlink(path, callback) { callback(enosys()); },\n\t\t\tutimes(path, atime, mtime, callback) { callback(enosys()); },\n\t\t};\n\t}\n\n\tif (!global.process) {\n\t\tglobal.process = {\n\t\t\tgetuid() { return -1; },\n\t\t\tgetgid() { return -1; },\n\t\t\tgeteuid() { return -1; },\n\t\t\tgetegid() { return -1; },\n\t\t\tgetgroups() { throw enosys(); },\n\t\t\tpid: -1,\n\t\t\tppid: -1,\n\t\t\tumask() { throw enosys(); },\n\t\t\tcwd() { throw enosys(); },\n\t\t\tchdir() { throw enosys(); },\n\t\t}\n\t}\n\n\tif (!global.crypto) {\n\t\tconst nodeCrypto = require(\"crypto\");\n\t\tglobal.crypto = {\n\t\t\tgetRandomValues(b) {\n\t\t\t\tnodeCrypto.randomFillSync(b);\n\t\t\t},\n\t\t};\n\t}\n\n\tif (!global.performance) {\n\t\tglobal.performance = {\n\t\t\tnow() {\n\t\t\t\tconst [sec, nsec] = process.hrtime();\n\t\t\t\treturn sec * 1000 + nsec / 1000000;\n\t\t\t},\n\t\t};\n\t}\n\n\tif (!global.TextEncoder) {\n\t\tglobal.TextEncoder = require(\"util\").TextEncoder;\n\t}\n\n\tif (!global.TextDecoder) {\n\t\tglobal.TextDecoder = require(\"util\").TextDecoder;\n\t}\n\n\t// End of polyfills for common API.\n\n\tconst encoder = new TextEncoder(\"utf-8\");\n\tconst decoder = new TextDecoder(\"utf-8\");\n\n\tglobal.Go = class {\n\t\tconstructor() {\n\t\t\tthis.argv = [\"js\"];\n\t\t\tthis.env = {};\n\t\t\tthis.exit = (code) => {\n\t\t\t\tif (code !== 0) {\n\t\t\t\t\tconsole.warn(\"exit code:\", code);\n\t\t\t\t}\n\t\t\t};\n\t\t\tthis._exitPromise = new Promise((resolve) => {\n\t\t\t\tthis._resolveExitPromise = resolve;\n\t\t\t});\n\t\t\tthis._pendingEvent = null;\n\t\t\tthis._scheduledTimeouts = new Map();\n\t\t\tthis._nextCallbackTimeoutID = 1;\n\n\t\t\tconst setInt64 = (addr, v) => {\n\t\t\t\tthis.mem.setUint32(addr + 0, v, true);\n\t\t\t\tthis.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);\n\t\t\t}\n\n\t\t\tconst getInt64 = (addr) => {\n\t\t\t\tconst low = this.mem.getUint32(addr + 0, true);\n\t\t\t\tconst high = this.mem.getInt32(addr + 4, true);\n\t\t\t\treturn low + high * 4294967296;\n\t\t\t}\n\n\t\t\tconst loadValue = (addr) => {\n\t\t\t\tconst f = this.mem.getFloat64(addr, true);\n\t\t\t\tif (f === 0) {\n\t\t\t\t\treturn undefined;\n\t\t\t\t}\n\t\t\t\tif (!isNaN(f)) {\n\t\t\t\t\treturn f;\n\t\t\t\t}\n\n\t\t\t\tconst id = this.mem.getUint32(addr, true);\n\t\t\t\treturn this._values[id];\n\t\t\t}\n\n\t\t\tconst storeValue = (addr, v) => {\n\t\t\t\tconst nanHead = 0x7FF80000;\n\n\t\t\t\tif (typeof v === \"number\" && v !== 0) {\n\t\t\t\t\tif (isNaN(v)) {\n\t\t\t\t\t\tthis.mem.setUint32(addr + 4, nanHead, true);\n\t\t\t\t\t\tthis.mem.setUint32(addr, 0, true);\n\t\t\t\t\t\treturn;\n\t\t\t\t\t}\n\t\t\t\t\tthis.mem.setFloat64(addr, v, true);\n\t\t\t\t\treturn;\n\t\t\t\t}\n\n\t\t\t\tif (v === undefined) {\n\t\t\t\t\tthis.mem.setFloat64(addr, 0, true);\n\t\t\t\t\treturn;\n\t\t\t\t}\n\n\t\t\t\tlet id = this._ids.get(v);\n\t\t\t\tif (id === undefined) {\n\t\t\t\t\tid = this._idPool.pop();\n\t\t\t\t\tif (id === undefined) {\n\t\t\t\t\t\tid = this._values.length;\n\t\t\t\t\t}\n\t\t\t\t\tthis._values[id] = v;\n\t\t\t\t\tthis._goRefCounts[id] = 0;\n\t\t\t\t\tthis._ids.set(v, id);\n\t\t\t\t}\n\t\t\t\tthis._goRefCounts[id]++;\n\t\t\t\tlet typeFlag = 0;\n\t\t\t\tswitch (typeof v) {\n\t\t\t\t\tcase \"object\":\n\t\t\t\t\t\tif (v !== null) {\n\t\t\t\t\t\t\ttypeFlag = 1;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tbreak;\n\t\t\t\t\tcase \"string\":\n\t\t\t\t\t\ttypeFlag = 2;\n\t\t\t\t\t\tbreak;\n\t\t\t\t\tcase \"symbol\":\n\t\t\t\t\t\ttypeFlag = 3;\n\t\t\t\t\t\tbreak;\n\t\t\t\t\tcase \"function\":\n\t\t\t\t\t\ttypeFlag = 4;\n\t\t\t\t\t\tbreak;\n\t\t\t\t}\n\t\t\t\tthis.mem.setUint32(addr + 4, nanHead | typeFlag, true);\n\t\t\t\tthis.mem.setUint32(addr, id, true);\n\t\t\t}\n\n\t\t\tconst loadSlice = (addr) => {\n\t\t\t\tconst array = getInt64(addr + 0);\n\t\t\t\tconst len = getInt64(addr + 8);\n\t\t\t\treturn new Uint8Array(this._inst.exports.mem.buffer, array, len);\n\t\t\t}\n\n\t\t\tconst loadSliceOfValues = (addr) => {\n\t\t\t\tconst array = getInt64(addr + 0);\n\t\t\t\tconst len = getInt64(addr + 8);\n\t\t\t\tconst a = new Array(len);\n\t\t\t\tfor (let i = 0; i < len; i++) {\n\t\t\t\t\ta[i] = loadValue(array + i * 8);\n\t\t\t\t}\n\t\t\t\treturn a;\n\t\t\t}\n\n\t\t\tconst loadString = (addr) => {\n\t\t\t\tconst saddr = getInt64(addr + 0);\n\t\t\t\tconst len = getInt64(addr + 8);\n\t\t\t\treturn decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len));\n\t\t\t}\n\n\t\t\tconst timeOrigin = Date.now() - performance.now();\n\t\t\tthis.importObject = {\n\t\t\t\tgo: {\n\t\t\t\t\t// Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)\n\t\t\t\t\t// may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported\n\t\t\t\t\t// function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).\n\t\t\t\t\t// This changes the SP, thus we have to update the SP used by the imported function.\n\n\t\t\t\t\t// func wasmExit(code int32)\n\t\t\t\t\t\"runtime.wasmExit\": (sp) => {\n\t\t\t\t\t\tconst code = this.mem.getInt32(sp + 8, true);\n\t\t\t\t\t\tthis.exited = true;\n\t\t\t\t\t\tdelete this._inst;\n\t\t\t\t\t\tdelete this._values;\n\t\t\t\t\t\tdelete this._goRefCounts;\n\t\t\t\t\t\tdelete this._ids;\n\t\t\t\t\t\tdelete this._idPool;\n\t\t\t\t\t\tthis.exit(code);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)\n\t\t\t\t\t\"runtime.wasmWrite\": (sp) => {\n\t\t\t\t\t\tconst fd = getInt64(sp + 8);\n\t\t\t\t\t\tconst p = getInt64(sp + 16);\n\t\t\t\t\t\tconst n = this.mem.getInt32(sp + 24, true);\n\t\t\t\t\t\tfs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));\n\t\t\t\t\t},\n\n\t\t\t\t\t// func resetMemoryDataView()\n\t\t\t\t\t\"runtime.resetMemoryDataView\": (sp) => {\n\t\t\t\t\t\tthis.mem = new DataView(this._inst.exports.mem.buffer);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func nanotime1() int64\n\t\t\t\t\t\"runtime.nanotime1\": (sp) => {\n\t\t\t\t\t\tsetInt64(sp + 8, (timeOrigin + performance.now()) * 1000000);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func walltime1() (sec int64, nsec int32)\n\t\t\t\t\t\"runtime.walltime1\": (sp) => {\n\t\t\t\t\t\tconst msec = (new Date).getTime();\n\t\t\t\t\t\tsetInt64(sp + 8, msec / 1000);\n\t\t\t\t\t\tthis.mem.setInt32(sp + 16, (msec % 1000) * 1000000, true);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func scheduleTimeoutEvent(delay int64) int32\n\t\t\t\t\t\"runtime.scheduleTimeoutEvent\": (sp) => {\n\t\t\t\t\t\tconst id = this._nextCallbackTimeoutID;\n\t\t\t\t\t\tthis._nextCallbackTimeoutID++;\n\t\t\t\t\t\tthis._scheduledTimeouts.set(id, setTimeout(\n\t\t\t\t\t\t\t() => {\n\t\t\t\t\t\t\t\tthis._resume();\n\t\t\t\t\t\t\t\twhile (this._scheduledTimeouts.has(id)) {\n\t\t\t\t\t\t\t\t\t// for some reason Go failed to register the timeout event, log and try again\n\t\t\t\t\t\t\t\t\t// (temporary workaround for https://github.com/golang/go/issues/28975)\n\t\t\t\t\t\t\t\t\tconsole.warn(\"scheduleTimeoutEvent: missed timeout event\");\n\t\t\t\t\t\t\t\t\tthis._resume();\n\t\t\t\t\t\t\t\t}\n\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\tgetInt64(sp + 8) + 1, // setTimeout has been seen to fire up to 1 millisecond early\n\t\t\t\t\t\t));\n\t\t\t\t\t\tthis.mem.setInt32(sp + 16, id, true);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func clearTimeoutEvent(id int32)\n\t\t\t\t\t\"runtime.clearTimeoutEvent\": (sp) => {\n\t\t\t\t\t\tconst id = this.mem.getInt32(sp + 8, true);\n\t\t\t\t\t\tclearTimeout(this._scheduledTimeouts.get(id));\n\t\t\t\t\t\tthis._scheduledTimeouts.delete(id);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func getRandomData(r []byte)\n\t\t\t\t\t\"runtime.getRandomData\": (sp) => {\n\t\t\t\t\t\tcrypto.getRandomValues(loadSlice(sp + 8));\n\t\t\t\t\t},\n\n\t\t\t\t\t// func finalizeRef(v ref)\n\t\t\t\t\t\"syscall/js.finalizeRef\": (sp) => {\n\t\t\t\t\t\tconst id = this.mem.getUint32(sp + 8, true);\n\t\t\t\t\t\tthis._goRefCounts[id]--;\n\t\t\t\t\t\tif (this._goRefCounts[id] === 0) {\n\t\t\t\t\t\t\tconst v = this._values[id];\n\t\t\t\t\t\t\tthis._values[id] = null;\n\t\t\t\t\t\t\tthis._ids.delete(v);\n\t\t\t\t\t\t\tthis._idPool.push(id);\n\t\t\t\t\t\t}\n\t\t\t\t\t},\n\n\t\t\t\t\t// func stringVal(value string) ref\n\t\t\t\t\t\"syscall/js.stringVal\": (sp) => {\n\t\t\t\t\t\tstoreValue(sp + 24, loadString(sp + 8));\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueGet(v ref, p string) ref\n\t\t\t\t\t\"syscall/js.valueGet\": (sp) => {\n\t\t\t\t\t\tconst result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));\n\t\t\t\t\t\tsp = this._inst.exports.getsp(); // see comment above\n\t\t\t\t\t\tstoreValue(sp + 32, result);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueSet(v ref, p string, x ref)\n\t\t\t\t\t\"syscall/js.valueSet\": (sp) => {\n\t\t\t\t\t\tReflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueDelete(v ref, p string)\n\t\t\t\t\t\"syscall/js.valueDelete\": (sp) => {\n\t\t\t\t\t\tReflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueIndex(v ref, i int) ref\n\t\t\t\t\t\"syscall/js.valueIndex\": (sp) => {\n\t\t\t\t\t\tstoreValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));\n\t\t\t\t\t},\n\n\t\t\t\t\t// valueSetIndex(v ref, i int, x ref)\n\t\t\t\t\t\"syscall/js.valueSetIndex\": (sp) => {\n\t\t\t\t\t\tReflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueCall(v ref, m string, args []ref) (ref, bool)\n\t\t\t\t\t\"syscall/js.valueCall\": (sp) => {\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tconst v = loadValue(sp + 8);\n\t\t\t\t\t\t\tconst m = Reflect.get(v, loadString(sp + 16));\n\t\t\t\t\t\t\tconst args = loadSliceOfValues(sp + 32);\n\t\t\t\t\t\t\tconst result = Reflect.apply(m, v, args);\n\t\t\t\t\t\t\tsp = this._inst.exports.getsp(); // see comment above\n\t\t\t\t\t\t\tstoreValue(sp + 56, result);\n\t\t\t\t\t\t\tthis.mem.setUint8(sp + 64, 1);\n\t\t\t\t\t\t} catch (err) {\n\t\t\t\t\t\t\tstoreValue(sp + 56, err);\n\t\t\t\t\t\t\tthis.mem.setUint8(sp + 64, 0);\n\t\t\t\t\t\t}\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueInvoke(v ref, args []ref) (ref, bool)\n\t\t\t\t\t\"syscall/js.valueInvoke\": (sp) => {\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tconst v = loadValue(sp + 8);\n\t\t\t\t\t\t\tconst args = loadSliceOfValues(sp + 16);\n\t\t\t\t\t\t\tconst result = Reflect.apply(v, undefined, args);\n\t\t\t\t\t\t\tsp = this._inst.exports.getsp(); // see comment above\n\t\t\t\t\t\t\tstoreValue(sp + 40, result);\n\t\t\t\t\t\t\tthis.mem.setUint8(sp + 48, 1);\n\t\t\t\t\t\t} catch (err) {\n\t\t\t\t\t\t\tstoreValue(sp + 40, err);\n\t\t\t\t\t\t\tthis.mem.setUint8(sp + 48, 0);\n\t\t\t\t\t\t}\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueNew(v ref, args []ref) (ref, bool)\n\t\t\t\t\t\"syscall/js.valueNew\": (sp) => {\n\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\tconst v = loadValue(sp + 8);\n\t\t\t\t\t\t\tconst args = loadSliceOfValues(sp + 16);\n\t\t\t\t\t\t\tconst result = Reflect.construct(v, args);\n\t\t\t\t\t\t\tsp = this._inst.exports.getsp(); // see comment above\n\t\t\t\t\t\t\tstoreValue(sp + 40, result);\n\t\t\t\t\t\t\tthis.mem.setUint8(sp + 48, 1);\n\t\t\t\t\t\t} catch (err) {\n\t\t\t\t\t\t\tstoreValue(sp + 40, err);\n\t\t\t\t\t\t\tthis.mem.setUint8(sp + 48, 0);\n\t\t\t\t\t\t}\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueLength(v ref) int\n\t\t\t\t\t\"syscall/js.valueLength\": (sp) => {\n\t\t\t\t\t\tsetInt64(sp + 16, parseInt(loadValue(sp + 8).length));\n\t\t\t\t\t},\n\n\t\t\t\t\t// valuePrepareString(v ref) (ref, int)\n\t\t\t\t\t\"syscall/js.valuePrepareString\": (sp) => {\n\t\t\t\t\t\tconst str = encoder.encode(String(loadValue(sp + 8)));\n\t\t\t\t\t\tstoreValue(sp + 16, str);\n\t\t\t\t\t\tsetInt64(sp + 24, str.length);\n\t\t\t\t\t},\n\n\t\t\t\t\t// valueLoadString(v ref, b []byte)\n\t\t\t\t\t\"syscall/js.valueLoadString\": (sp) => {\n\t\t\t\t\t\tconst str = loadValue(sp + 8);\n\t\t\t\t\t\tloadSlice(sp + 16).set(str);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func valueInstanceOf(v ref, t ref) bool\n\t\t\t\t\t\"syscall/js.valueInstanceOf\": (sp) => {\n\t\t\t\t\t\tthis.mem.setUint8(sp + 24, (loadValue(sp + 8) instanceof loadValue(sp + 16)) ? 1 : 0);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func copyBytesToGo(dst []byte, src ref) (int, bool)\n\t\t\t\t\t\"syscall/js.copyBytesToGo\": (sp) => {\n\t\t\t\t\t\tconst dst = loadSlice(sp + 8);\n\t\t\t\t\t\tconst src = loadValue(sp + 32);\n\t\t\t\t\t\tif (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {\n\t\t\t\t\t\t\tthis.mem.setUint8(sp + 48, 0);\n\t\t\t\t\t\t\treturn;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tconst toCopy = src.subarray(0, dst.length);\n\t\t\t\t\t\tdst.set(toCopy);\n\t\t\t\t\t\tsetInt64(sp + 40, toCopy.length);\n\t\t\t\t\t\tthis.mem.setUint8(sp + 48, 1);\n\t\t\t\t\t},\n\n\t\t\t\t\t// func copyBytesToJS(dst ref, src []byte) (int, bool)\n\t\t\t\t\t\"syscall/js.copyBytesToJS\": (sp) => {\n\t\t\t\t\t\tconst dst = loadValue(sp + 8);\n\t\t\t\t\t\tconst src = loadSlice(sp + 16);\n\t\t\t\t\t\tif (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {\n\t\t\t\t\t\t\tthis.mem.setUint8(sp + 48, 0);\n\t\t\t\t\t\t\treturn;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tconst toCopy = src.subarray(0, dst.length);\n\t\t\t\t\t\tdst.set(toCopy);\n\t\t\t\t\t\tsetInt64(sp + 40, toCopy.length);\n\t\t\t\t\t\tthis.mem.setUint8(sp + 48, 1);\n\t\t\t\t\t},\n\n\t\t\t\t\t\"debug\": (value) => {\n\t\t\t\t\t\tconsole.log(value);\n\t\t\t\t\t},\n\t\t\t\t}\n\t\t\t};\n\t\t}\n\n\t\tasync run(instance) {\n\t\t\tthis._inst = instance;\n\t\t\tthis.mem = new DataView(this._inst.exports.mem.buffer);\n\t\t\tthis._values = [ // JS values that Go currently has references to, indexed by reference id\n\t\t\t\tNaN,\n\t\t\t\t0,\n\t\t\t\tnull,\n\t\t\t\ttrue,\n\t\t\t\tfalse,\n\t\t\t\tglobal,\n\t\t\t\tthis,\n\t\t\t];\n\t\t\tthis._goRefCounts = new Array(this._values.length).fill(Infinity); // number of references that Go has to a JS value, indexed by reference id\n\t\t\tthis._ids = new Map([ // mapping from JS values to reference ids\n\t\t\t\t[0, 1],\n\t\t\t\t[null, 2],\n\t\t\t\t[true, 3],\n\t\t\t\t[false, 4],\n\t\t\t\t[global, 5],\n\t\t\t\t[this, 6],\n\t\t\t]);\n\t\t\tthis._idPool = [];   // unused ids that have been garbage collected\n\t\t\tthis.exited = false; // whether the Go program has exited\n\n\t\t\t// Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.\n\t\t\tlet offset = 4096;\n\n\t\t\tconst strPtr = (str) => {\n\t\t\t\tconst ptr = offset;\n\t\t\t\tconst bytes = encoder.encode(str + \"\\0\");\n\t\t\t\tnew Uint8Array(this.mem.buffer, offset, bytes.length).set(bytes);\n\t\t\t\toffset += bytes.length;\n\t\t\t\tif (offset % 8 !== 0) {\n\t\t\t\t\toffset += 8 - (offset % 8);\n\t\t\t\t}\n\t\t\t\treturn ptr;\n\t\t\t};\n\n\t\t\tconst argc = this.argv.length;\n\n\t\t\tconst argvPtrs = [];\n\t\t\tthis.argv.forEach((arg) => {\n\t\t\t\targvPtrs.push(strPtr(arg));\n\t\t\t});\n\t\t\targvPtrs.push(0);\n\n\t\t\tconst keys = Object.keys(this.env).sort();\n\t\t\tkeys.forEach((key) => {\n\t\t\t\targvPtrs.push(strPtr(`${key}=${this.env[key]}`));\n\t\t\t});\n\t\t\targvPtrs.push(0);\n\n\t\t\tconst argv = offset;\n\t\t\targvPtrs.forEach((ptr) => {\n\t\t\t\tthis.mem.setUint32(offset, ptr, true);\n\t\t\t\tthis.mem.setUint32(offset + 4, 0, true);\n\t\t\t\toffset += 8;\n\t\t\t});\n\n\t\t\tthis._inst.exports.run(argc, argv);\n\t\t\tif (this.exited) {\n\t\t\t\tthis._resolveExitPromise();\n\t\t\t}\n\t\t\tawait this._exitPromise;\n\t\t}\n\n\t\t_resume() {\n\t\t\tif (this.exited) {\n\t\t\t\tthrow new Error(\"Go program has already exited\");\n\t\t\t}\n\t\t\tthis._inst.exports.resume();\n\t\t\tif (this.exited) {\n\t\t\t\tthis._resolveExitPromise();\n\t\t\t}\n\t\t}\n\n\t\t_makeFuncWrapper(id) {\n\t\t\tconst go = this;\n\t\t\treturn function () {\n\t\t\t\tconst event = { id: id, this: this, args: arguments };\n\t\t\t\tgo._pendingEvent = event;\n\t\t\t\tgo._resume();\n\t\t\t\treturn event.result;\n\t\t\t};\n\t\t}\n\t}\n\n\tif (\n\t\tglobal.require &&\n\t\tglobal.require.main === module &&\n\t\tglobal.process &&\n\t\tglobal.process.versions &&\n\t\t!global.process.versions.electron\n\t) {\n\t\tif (process.argv.length < 3) {\n\t\t\tconsole.error(\"usage: go_js_wasm_exec [wasm binary] [arguments]\");\n\t\t\tprocess.exit(1);\n\t\t}\n\n\t\tconst go = new Go();\n\t\tgo.argv = process.argv.slice(2);\n\t\tgo.env = Object.assign({ TMPDIR: require(\"os\").tmpdir() }, process.env);\n\t\tgo.exit = process.exit;\n\t\tWebAssembly.instantiate(fs.readFileSync(process.argv[2]), go.importObject).then((result) => {\n\t\t\tprocess.on(\"exit\", (code) => { // Node.js exits if no event handler is pending\n\t\t\t\tif (code === 0 && !go.exited) {\n\t\t\t\t\t// deadlock, make Go print error and stack traces\n\t\t\t\t\tgo._pendingEvent = { id: 0 };\n\t\t\t\t\tgo._resume();\n\t\t\t\t}\n\t\t\t});\n\t\t\treturn go.run(result.instance);\n\t\t}).catch((err) => {\n\t\t\tconsole.error(err);\n\t\t\tprocess.exit(1);\n\t\t});\n\t}\n})();\n"],"6":["/* eslint-env browser */\n/* global Go fs drand */\nimport /*'./wasm/wasm_exec.js'*/",{"m":5},"\n\nclass Verifier {\n  static instance () {\n    if (Verifier._instance) {\n      return Verifier._instance\n    }\n    Verifier._instance = (async function () {\n      try {\n        // TODO: switch to TinyGo when math/big works for smaller wasm file and non-global exports.\n        const go = new Go()\n        const url = `https://cdn.jsdelivr.net/npm/drand-client@0.2.0/wasm/drand.wasm`\n        let result\n        \n          const res = await fetch(url)\n          if (!res.ok) throw new Error(`unexpected HTTP status fetching WASM ${res.status}`)\n let buffer=await res.arrayBuffer();if(new Uint8Array(await crypto.subtle.digest(\"SHA-256\",buffer)).join(\",\")!=\"144,157,42,18,255,22,200,60,109,226,232,145,158,48,59,158,49,125,98,64,156,65,73,60,235,143,96,149,82,79,32,232\")throw new Error(\"Bad wasm hash\");         result = await WebAssembly.instantiate(buffer, go.importObject)\n        \n        go.run(result.instance)\n        return drand // window.drand / global.drand should now be available\n      } catch (err) {\n        Verifier._instance = null\n        throw err\n      }\n    })()\n    return Verifier._instance\n  }\n}\n\nexport default class Verifying {\n  constructor (client, options) {\n    this._client = client\n    this._options = options || {}\n  }\n\n  async get (round, options) {\n    options = options || {}\n    const rand = await this._client.get(round, options)\n    return this._verify(rand, { signal: options.signal })\n  }\n\n  info (options) {\n    return this._client.info(options)\n  }\n\n  async * watch (options) {\n    options = options || {}\n    for await (let rand of this._client.watch(options)) {\n      rand = await this._verify(rand, { signal: options.signal })\n      yield rand\n    }\n  }\n\n  roundAt (time) {\n    return this._client.roundAt(time)\n  }\n\n  async _verify (rand, options) {\n    // TODO: full/partial chain verification\n    const info = await this.info(options)\n    const verifier = await Verifier.instance()\n    await verifier.verifyBeacon(info.public_key, rand)\n    // TODO: derive the randomness from the signature\n    return { ...rand }\n  }\n\n  async close () {\n    return this._client.close()\n  }\n}\n"],"7":["import HTTP from /*'./http.js'*/",{"m":3},"\nimport Optimizing from /*'./optimizing.js'*/",{"m":4},"\nimport Verifying from /*'./verifying.js'*/",{"m":6},"\n\nasync function wrap (clients, options) {\n  clients = await Promise.resolve(clients)\n  const cfg = options || {}\n  cfg.clients = clients || []\n  cfg.cacheSize = cfg.cacheSize || 32\n  return makeClient(cfg)\n}\n\nasync function makeClient (cfg) {\n  if (!cfg.insecure && cfg.chainHash == null && cfg.chainInfo == null) {\n    throw new Error('no root of trust specified')\n  }\n  if (cfg.clients.length === 0 && cfg.watcher == null) {\n    throw new Error('no points of contact specified')\n  }\n\n  // TODO: watcher\n\n  if (!cfg.disableBeaconVerification) {\n    cfg.clients = cfg.clients.map(c => new Verifying(c))\n  }\n\n  const client = new Optimizing(cfg.clients)\n  await client.start()\n\n  // TODO: caching\n  // TODO: aggregating\n\n  return client\n}\n\nconst Client = { wrap }\n\nexport default Client\nexport { HTTP }\n"],"8":["export * as drandClient from /*\"https://cdn.jsdelivr.net/npm/drand-client/drand.js\"*/",{"m":7},";"]},f=8,u=(c,f)=>URL.createObjectURL(new Blob(c[f].map(e=>typeof e=="object"?JSON.stringify(u(c,e.m)):e),{type:"text/javascript"})),d=u(c,f);console.log(d);let m=await import(d);export const HTTP=m["drandClient"].HTTP;export default m["drandClient"].default