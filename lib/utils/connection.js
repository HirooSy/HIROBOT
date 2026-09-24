import chalk from './color.js'
import fs from 'fs'
import path, { resolve } from 'path'
import readline from 'readline'
import crypto from 'crypto'
import { DatabaseSync } from 'node:sqlite'
import db, { loadDatabase } from './database.js'
import Helper from './helper.js'
import { fileURLToPath } from 'url'
import { HelperConnection } from './simple.js'

// ─── qrcode-terminal (inlined, native ESM) ────────────────────────────────────
const _QRErrorCorrectLevel = { L: 1, M: 0, Q: 3, H: 2 }

const _QRMath = (() => {
  const EXP = new Array(256), LOG = new Array(256)
  for (let i = 0; i < 8; i++) EXP[i] = 1 << i
  for (let i = 8; i < 256; i++) EXP[i] = EXP[i-4] ^ EXP[i-5] ^ EXP[i-6] ^ EXP[i-8]
  for (let i = 0; i < 255; i++) LOG[EXP[i]] = i
  return {
    glog: n => { if (n < 1) throw new Error('glog(' + n + ')'); return LOG[n] },
    gexp: n => EXP[((n % 255) + 255) % 255],
  }
})()

class _QRPoly {
  constructor(num, shift) {
    let o = 0; while (o < num.length && num[o] === 0) o++
    this.num = new Array(num.length - o + shift)
    for (let i = 0; i < num.length - o; i++) this.num[i] = num[i + o]
  }
  get(i) { return this.num[i] }
  getLength() { return this.num.length }
  multiply(e) {
    const n = new Array(this.getLength() + e.getLength() - 1).fill(0)
    for (let i = 0; i < this.getLength(); i++)
      for (let j = 0; j < e.getLength(); j++)
        n[i+j] ^= _QRMath.gexp(_QRMath.glog(this.get(i)) + _QRMath.glog(e.get(j)))
    return new _QRPoly(n, 0)
  }
  mod(e) {
    if (this.getLength() - e.getLength() < 0) return this
    const r = _QRMath.glog(this.get(0)) - _QRMath.glog(e.get(0))
    const n = this.num.slice()
    for (let i = 0; i < e.getLength(); i++) n[i] ^= _QRMath.gexp(_QRMath.glog(e.get(i)) + r)
    return new _QRPoly(n, 0).mod(e)
  }
}

const _RS_TABLE = [
  [1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],
  [1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],
  [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],
  [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
  [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
  [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
  [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
  [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
  [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
  [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
  [4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],
  [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
  [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
  [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
  [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
  [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
  [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
  [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
  [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
  [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16],
]

class _QRRSBlock {
  constructor(t, d) { this.totalCount = t; this.dataCount = d }
  static get(typeNumber, ecLevel) {
    const t = _RS_TABLE[(typeNumber - 1) * 4 + [1,0,3,2][ecLevel]]
    const list = []
    for (let i = 0; i < t.length; i += 3)
      for (let j = 0; j < t[i]; j++) list.push(new _QRRSBlock(t[i+1], t[i+2]))
    return list
  }
}

class _QRBitBuf {
  constructor() { this.buffer = []; this.length = 0 }
  get(i) { return ((this.buffer[Math.floor(i/8)] >>> (7 - i%8)) & 1) === 1 }
  put(num, len) { for (let i = 0; i < len; i++) this.putBit(((num >>> (len-i-1)) & 1) === 1) }
  getLengthInBits() { return this.length }
  putBit(bit) {
    const bi = Math.floor(this.length/8)
    if (this.buffer.length <= bi) this.buffer.push(0)
    if (bit) this.buffer[bi] |= 0x80 >>> (this.length % 8)
    this.length++
  }
}

class _QRCode {
  constructor(typeNumber, ecLevel) {
    this.typeNumber = typeNumber; this.errorCorrectLevel = ecLevel
    this.modules = null; this.moduleCount = 0; this.dataCache = null; this.dataList = []
  }
  addData(data) {
    const obj = { mode: 4, data, parsedData: [] }
    const d = unescape(encodeURIComponent(data))
    for (let i = 0; i < d.length; i++) obj.parsedData.push(d.charCodeAt(i))
    obj.getLength = () => obj.parsedData.length
    obj.write = buf => { for (let i = 0; i < obj.parsedData.length; i++) buf.put(obj.parsedData[i], 8) }
    this.dataList.push(obj); this.dataCache = null
  }
  isDark(r, c) { return this.modules[r][c] }
  getModuleCount() { return this.moduleCount }
  make() { this._make(false, this._bestMask()) }
  _make(test, mask) {
    if (this.typeNumber < 1) {
      let t = 1
      for (; t < 40; t++) {
        const rs = _QRRSBlock.get(t, this.errorCorrectLevel)
        const buf = new _QRBitBuf()
        let total = rs.reduce((s,b) => s + b.dataCount, 0)
        for (const d of this.dataList) { buf.put(d.mode, 4); buf.put(d.getLength(), this._lenBits(d.mode, t)); d.write(buf) }
        if (buf.getLengthInBits() <= total * 8) break
      }
      this.typeNumber = t
    }
    this.moduleCount = this.typeNumber * 4 + 17
    this.modules = Array.from({length: this.moduleCount}, () => new Array(this.moduleCount).fill(null))
    this._probe(0, 0); this._probe(this.moduleCount-7, 0); this._probe(0, this.moduleCount-7)
    this._adjust(); this._timing(); this._typeInfo(test, mask)
    if (this.typeNumber >= 7) this._typeNum(test)
    if (!this.dataCache) this.dataCache = this._buildData()
    this._map(this.dataCache, mask)
  }
  _probe(row, col) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      if (row+r < 0 || this.moduleCount <= row+r || col+c < 0 || this.moduleCount <= col+c) continue
      this.modules[row+r][col+c] = (0<=r&&r<=6&&(c===0||c===6))||(0<=c&&c<=6&&(r===0||r===6))||(2<=r&&r<=4&&2<=c&&c<=4)
    }
  }
  _bestMask() {
    let min = 0, pat = 0
    for (let i = 0; i < 8; i++) { this._make(true, i); const lp = this._lostPoint(); if (i===0||min>lp){min=lp;pat=i} }
    return pat
  }
  _timing() {
    for (let r = 8; r < this.moduleCount-8; r++) if (this.modules[r][6]===null) this.modules[r][6] = r%2===0
    for (let c = 8; c < this.moduleCount-8; c++) if (this.modules[6][c]===null) this.modules[6][c] = c%2===0
  }
  _adjust() {
    const pos = this._patPos()
    for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
      const row = pos[i], col = pos[j]
      if (this.modules[row][col] !== null) continue
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++)
        this.modules[row+r][col+c] = r===-2||r===2||c===-2||c===2||(r===0&&c===0)
    }
  }
  _typeNum(test) {
    const bits = this._bchTypeNum(this.typeNumber)
    for (let i = 0; i < 18; i++) {
      const m = !test && ((bits>>i)&1)===1
      this.modules[Math.floor(i/3)][i%3+this.moduleCount-8-3] = m
      this.modules[i%3+this.moduleCount-8-3][Math.floor(i/3)] = m
    }
  }
  _typeInfo(test, mask) {
    const bits = this._bchTypeInfo((this.errorCorrectLevel<<3)|mask)
    for (let i = 0; i < 15; i++) {
      const m = !test && ((bits>>i)&1)===1
      if (i<6) this.modules[i][8]=m; else if (i<8) this.modules[i+1][8]=m; else this.modules[this.moduleCount-15+i][8]=m
      if (i<8) this.modules[8][this.moduleCount-i-1]=m; else if (i<9) this.modules[8][15-i]=m; else this.modules[8][15-i-1]=m
    }
    this.modules[this.moduleCount-8][8] = !test
  }
  _map(data, mask) {
    let inc = -1, row = this.moduleCount-1, bi = 7, by = 0
    const mf = [(i,j)=>(i+j)%2===0,(i)=>i%2===0,(_,j)=>j%3===0,(i,j)=>(i+j)%3===0,(i,j)=>(Math.floor(i/2)+Math.floor(j/3))%2===0,(i,j)=>(i*j)%2+(i*j)%3===0,(i,j)=>((i*j)%2+(i*j)%3)%2===0,(i,j)=>((i+j)%2+(i*j)%3)%2===0][mask]
    for (let col = this.moduleCount-1; col > 0; col -= 2) {
      if (col===6) col--
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (this.modules[row][col-c]===null) {
            let dark = by < data.length && ((data[by]>>>bi)&1)===1
            if (mf(row,col-c)) dark=!dark
            this.modules[row][col-c]=dark; bi--
            if (bi===-1){by++;bi=7}
          }
        }
        row+=inc
        if (row<0||this.moduleCount<=row){row-=inc;inc=-inc;break}
      }
    }
  }
  _lostPoint() {
    const m = this.moduleCount; let lp = 0
    for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) {
      let sc = 0; const dark = this.isDark(r, c)
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (r+dr<0||m<=r+dr||c+dc<0||m<=c+dc||(!dr&&!dc)) continue
        if (dark===this.isDark(r+dr,c+dc)) sc++
      }
      if (sc>5) lp+=3+sc-5
    }
    for (let r = 0; r < m-1; r++) for (let c = 0; c < m-1; c++) {
      let cnt=0
      if(this.isDark(r,c))cnt++;if(this.isDark(r+1,c))cnt++;if(this.isDark(r,c+1))cnt++;if(this.isDark(r+1,c+1))cnt++
      if(cnt===0||cnt===4)lp+=3
    }
    for (let r = 0; r < m; r++) for (let c = 0; c < m-6; c++)
      if(this.isDark(r,c)&&!this.isDark(r,c+1)&&this.isDark(r,c+2)&&this.isDark(r,c+3)&&this.isDark(r,c+4)&&!this.isDark(r,c+5)&&this.isDark(r,c+6))lp+=40
    for (let c = 0; c < m; c++) for (let r = 0; r < m-6; r++)
      if(this.isDark(r,c)&&!this.isDark(r+1,c)&&this.isDark(r+2,c)&&this.isDark(r+3,c)&&this.isDark(r+4,c)&&!this.isDark(r+5,c)&&this.isDark(r+6,c))lp+=40
    let dc=0; for(let c=0;c<m;c++) for(let r=0;r<m;r++) if(this.isDark(r,c))dc++
    lp+=Math.abs(Math.floor(dc*100/m/m-50))/5*10
    return lp
  }
  _patPos() { return [[],(6,18),(6,22),(6,26),(6,30),(6,34),(6,22,38),(6,24,42),(6,26,46),(6,28,50),(6,30,54),(6,32,58),(6,34,62),(6,26,46,66),(6,26,48,70),(6,26,50,74),(6,30,54,78),(6,30,56,82),(6,30,58,86),(6,34,62,90),(6,28,50,72,94),(6,26,50,74,98),(6,30,54,78,102),(6,28,54,80,106),(6,32,58,84,110),(6,30,58,86,114),(6,34,62,90,118),(6,26,50,74,98,122),(6,30,54,78,102,126),(6,26,52,78,104,130),(6,30,56,82,108,134),(6,34,60,86,112,138),(6,30,58,86,114,142),(6,34,62,90,118,146),(6,30,54,78,102,126,150),(6,24,50,76,102,128,154),(6,28,54,80,106,132,158),(6,32,58,84,110,136,162),(6,26,54,82,110,138,166),(6,30,58,86,114,142,170)][this.typeNumber] }
  _bchTypeInfo(d) { let x=d<<10; while(this._bchDigit(x)-this._bchDigit(0x537)>=0)x^=0x537<<(this._bchDigit(x)-this._bchDigit(0x537)); return((d<<10)|x)^0x5412 }
  _bchTypeNum(d) { let x=d<<12; while(this._bchDigit(x)-this._bchDigit(0x1F25)>=0)x^=0x1F25<<(this._bchDigit(x)-this._bchDigit(0x1F25)); return(d<<12)|x }
  _bchDigit(d) { let n=0; while(d!==0){n++;d>>>=1} return n }
  _lenBits(mode, t) {
    if(mode===1)return t<10?10:t<27?12:14
    if(mode===2)return t<10?9:t<27?11:13
    if(mode===4)return t<10?8:16
    if(mode===8)return t<10?8:t<27?10:12
  }
  _buildData() {
    const rs = _QRRSBlock.get(this.typeNumber, this.errorCorrectLevel)
    const buf = new _QRBitBuf()
    for (const d of this.dataList) { buf.put(d.mode,4); buf.put(d.getLength(),this._lenBits(d.mode,this.typeNumber)); d.write(buf) }
    const total = rs.reduce((s,b)=>s+b.dataCount,0)
    if (buf.getLengthInBits()>total*8) throw new Error('code length overflow')
    if (buf.getLengthInBits()+4<=total*8) buf.put(0,4)
    while(buf.getLengthInBits()%8!==0)buf.putBit(false)
    while(true){if(buf.getLengthInBits()>=total*8)break;buf.put(0xEC,8);if(buf.getLengthInBits()>=total*8)break;buf.put(0x11,8)}
    return this._buildBytes(buf, rs)
  }
  _buildBytes(buf, rs) {
    let off=0,maxDc=0,maxEc=0
    const dc=new Array(rs.length),ec=new Array(rs.length)
    for(let r=0;r<rs.length;r++){
      const dCnt=rs[r].dataCount,eCnt=rs[r].totalCount-dCnt
      maxDc=Math.max(maxDc,dCnt);maxEc=Math.max(maxEc,eCnt)
      dc[r]=new Array(dCnt); for(let i=0;i<dCnt;i++)dc[r][i]=0xff&buf.buffer[i+off]; off+=dCnt
      const rsp=this._ecPoly(eCnt),raw=new _QRPoly(dc[r],rsp.getLength()-1),mod=raw.mod(rsp)
      ec[r]=new Array(rsp.getLength()-1)
      for(let i=0;i<ec[r].length;i++){const mi=i+mod.getLength()-ec[r].length;ec[r][i]=mi>=0?mod.get(mi):0}
    }
    const total=rs.reduce((s,b)=>s+b.totalCount,0),data=new Array(total)
    let idx=0
    for(let i=0;i<maxDc;i++)for(let r=0;r<rs.length;r++)if(i<dc[r].length)data[idx++]=dc[r][i]
    for(let i=0;i<maxEc;i++)for(let r=0;r<rs.length;r++)if(i<ec[r].length)data[idx++]=ec[r][i]
    return data
  }
  _ecPoly(len){let a=new _QRPoly([1],0);for(let i=0;i<len;i++)a=a.multiply(new _QRPoly([1,_QRMath.gexp(i)],0));return a}
}

function generateQR(input, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  opts = opts || {}
  const qr = new _QRCode(-1, _QRErrorCorrectLevel.L)
  qr.addData(input); qr.make()
  const BLACK = '\x1b[40m  \x1b[0m', WHITE = '\x1b[47m  \x1b[0m'
  let output = ''
  if (opts.small) {
    const mc = qr.getModuleCount(), md = qr.modules.slice()
    if (mc % 2 === 1) md.push(new Array(mc).fill(false))
    const p = {WW:'\u2588',WB:'\u2580',BW:'\u2584',BB:' '}
    output += p.BW.repeat(mc+3)+'\n'
    for (let r = 0; r < mc; r += 2) {
      output += p.WW
      for (let c = 0; c < mc; c++) {
        const t=md[r][c],b=md[r+1][c]
        output += (!t&&!b)?p.WW:(!t&&b)?p.WB:(t&&!b)?p.BW:p.BB
      }
      output += p.WW+'\n'
    }
    if (mc%2===0) output += p.WB.repeat(mc+3)
  } else {
    const border = WHITE.repeat(qr.getModuleCount()+2)
    output += border+'\n'
    qr.modules.forEach(row => { output += WHITE+row.map(c=>c?BLACK:WHITE).join('')+WHITE+'\n' })
    output += border
  }
  if (cb) cb(output); else console.log(output)
}
// ─── end qrcode-terminal ──────────────────────────────────────────────────────


const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  PHONENUMBER_MCC,
  Browsers,
  BufferJSON,
  makeCacheableSignalKeyStore,
  proto,
  isJidBroadcast,
  isJidGroup,
  WAMessageStubType,
  updateMessageWithReceipt,
  updateMessageWithReaction,
  decryptPollVote,
  getKeyAuthor,
  jidNormalizedUser,
  initAuthCreds,
  useMultiFileAuthState
} = await import('baileys')

class StoreLock {
  #chains = new Map()

  run(key, task) {
    const previous = this.#chains.get(key)
    const current = previous ? previous.then(task, task) : task()
    const tracker = Promise.resolve(current).then(() => {}, () => {})
    this.#chains.set(key, tracker)
    tracker.then(() => {
      if (this.#chains.get(key) === tracker) this.#chains.delete(key)
    })
    return current
  }

  runMany(keys, task) {
    const unique = [...new Set(keys)].sort()
    if (unique.length === 0) return task()
    if (unique.length === 1) return this.run(unique[0], task)
    const acquire = (i) =>
      i >= unique.length
        ? task()
        : this.run(unique[i], () => acquire(i + 1))
    return acquire(0)
  }
}

const signalKeyLock = new StoreLock()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TIME_TO_DATA_STALE = 5 * 60 * 1000
const MAX_MESSAGES_PER_CHAT = 100

function makeInMemoryStore() {
  let chats = {}
  let messages = {}
  let state = { connection: 'close' }

  function loadMessage(jid, id = null) {
    let message = null
    if (jid && !id) {
      id = jid
      const filter = (m) => m.key?.id == id
      const messageFind = Object.entries(messages).find(([, msgs]) => msgs.find(filter))
      message = messageFind?.[1]?.find(filter)
    } else {
      jid = jid?.decodeJid?.()
      if (!(jid in messages)) return null
      message = messages[jid].find(m => m.key.id == id)
    }
    return message ? message : null
  }

  async function fetchGroupMetadata(jid, groupMetadata) {
    jid = jid?.decodeJid?.()
    if (!isJidGroup(jid)) return
    if (!(jid in chats)) return chats[jid] = { id: jid }
    const isRequiredToUpdate = !chats[jid].metadata || Date.now() - (chats[jid].lastfetch || 0) > TIME_TO_DATA_STALE
    if (isRequiredToUpdate) {
      const metadata = await groupMetadata?.(jid)
      if (metadata) Object.assign(chats[jid], {
        subject: metadata.subject,
        lastfetch: Date.now(),
        metadata
      })
    }
    return chats[jid].metadata
  }

  function getContact(jid) {
    jid = jid?.decodeJid?.()
    if (!(jid in chats)) return null
    return chats[jid]
  }

  function getNumberFromLid(lidNumber) {
    if (!lidNumber || !lidNumber.endsWith('@lid')) return null
    const lidNum = lidNumber.split('@')[0]

    const direct = chats[lidNumber]
    if (direct?.number?.endsWith('@s.whatsapp.net')) {
      console.log(`[Store] LID reverse map hit: ${lidNumber} → ${direct.number}`)
      return direct.number
    }

    for (const [jid, contact] of Object.entries(chats)) {
      if (!jid.endsWith('@s.whatsapp.net')) continue
      if (contact.lid === lidNumber || contact.linkedIdentity === lidNumber) {
        console.log(`[Store] Found via contact.lid: ${lidNumber} → ${jid}`)
        return jid
      }
    }

    for (const [groupJid, chat] of Object.entries(chats)) {
      if (!groupJid.endsWith('@g.us')) continue
      const participants = chat.metadata?.participants
      if (!Array.isArray(participants)) continue
      for (const p of participants) {
        let pLid = null
        let pNumber = null
        const rawId = p.id
        if (rawId && typeof rawId === 'object') {
          const innerId = String(rawId.id || rawId.jid || '')
          if (innerId.endsWith('@lid')) pLid = innerId
          const innerPn = rawId.phoneNumber || rawId.pn || ''
          if (String(innerPn).endsWith('@s.whatsapp.net')) pNumber = String(innerPn)
        } else if (typeof rawId === 'string') {
          if (rawId.endsWith('@lid')) pLid = rawId
          else if (rawId.endsWith('@s.whatsapp.net')) pNumber = rawId
        }
        const topPn = p.phoneNumber || p.pn || p.phone_number
        if (topPn) {
          if (String(topPn).endsWith('@s.whatsapp.net')) pNumber = String(topPn)
          else {
            const c = String(topPn).replace(/[^0-9]/g, '')
            if (c.length >= 7) pNumber = c + '@s.whatsapp.net'
          }
        }
        if (p.lid && String(p.lid).endsWith('@lid')) pLid = String(p.lid)

        const isMatch = pLid === lidNumber || pLid?.split('@')[0] === lidNum
        if (!isMatch) continue
        if (pNumber) {
          console.log(`[Store] Found via group ${groupJid}: ${lidNumber} → ${pNumber}`)
          return pNumber
        }
      }
    }
    return null
  }

  function getLidFromNumber(number) {
    if (!number || !number.endsWith('@s.whatsapp.net')) return null
    const contact = chats[number]
    if (contact && (contact.lid || contact.linkedIdentity)) {
      return contact.lid || contact.linkedIdentity
    }
    return null
  }

  function cachePnFromParticipants(participants) {
    if (!Array.isArray(participants)) return
    for (const p of participants) {
      let pLid = null
      let pNumber = null

      const rawId = p.id
      if (rawId && typeof rawId === 'object') {
        const innerId = String(rawId.id || rawId.jid || '')
        if (innerId.endsWith('@lid')) pLid = innerId
        const innerPn = rawId.phoneNumber || rawId.pn || ''
        if (String(innerPn).endsWith('@s.whatsapp.net')) pNumber = String(innerPn)
      } else if (typeof rawId === 'string' && rawId.endsWith('@lid')) {
        pLid = rawId
      }

      const topPn = p.phoneNumber || p.pn || p.phone_number
      if (topPn) {
        if (String(topPn).endsWith('@s.whatsapp.net')) pNumber = String(topPn)
        else {
          const c = String(topPn).replace(/[^0-9]/g, '')
          if (c.length >= 7) pNumber = c + '@s.whatsapp.net'
        }
      }
      if (p.lid && String(p.lid).endsWith('@lid')) pLid = String(p.lid)

      if (pLid && pNumber) {
        if (!chats[pLid]) chats[pLid] = {}
        if (!chats[pLid].number) {
          chats[pLid].number = pNumber
          chats[pLid].lid = pLid
          console.log(`[Store] cachePn: ${pLid} → ${pNumber}`)
        }
        if (!chats[pNumber]) chats[pNumber] = {}
        if (!chats[pNumber].lid) {
          chats[pNumber].lid = pLid
        }
      }
    }
  }

  const upsertMessage = (jid, message, type = 'append') => {
    jid = jid?.decodeJid?.()
    if (!(jid in messages)) messages[jid] = []

    delete message.message?.messageContextInfo
    delete message.message?.senderKeyDistributionMessage

    if (!chats[jid]) chats[jid] = {}
    chats[jid].lastfetch = Date.now()

    const msg = loadMessage(jid, message.key.id)
    if (msg) {
      Object.assign(msg, message)
    } else if (type == 'append') {
      messages[jid].push(message)
      if (messages[jid].length > MAX_MESSAGES_PER_CHAT) {
        messages[jid] = messages[jid].slice(-MAX_MESSAGES_PER_CHAT)
      }
    } else {
      messages[jid].splice(0, 0, message)
      if (messages[jid].length > MAX_MESSAGES_PER_CHAT) {
        messages[jid] = messages[jid].slice(0, MAX_MESSAGES_PER_CHAT)
      }
    }
  }

  function bind(ev, opts = { groupMetadata: () => null }) {
    ev.on('connection.update', update => {
      Object.assign(state, update)
    })

    ev.on('chats.set', function store(chatsSet) {
      for (const chat of chatsSet.chats) {
        const id = chat.id?.decodeJid?.()
        if (!id) continue
        if (!(id in chats)) chats[id] = { ...chat, isChats: true, ...(chat.name ? { name: chat.name } : {}) }
        if (chat.name) chats[id].name = chat.name
      }
    })

    ev.on('contacts.set', function store(contactsSet) {
      for (const contact of contactsSet.contacts) {
        const id = contact.id?.decodeJid?.()
        if (!id) continue
        chats[id] = Object.assign(chats[id] || {}, { ...contact, isContact: true })

        const lid = contact.lid || contact.linkedIdentity
        if (lid && lid.endsWith('@lid') && id.endsWith('@s.whatsapp.net')) {
          if (!chats[lid]) chats[lid] = {}
          chats[lid].number = id
          chats[lid].lid = lid
          console.log(`[Store] contacts.set LID mapping: ${lid} → ${id}`)
        }
      }
    })

    ev.on('messages.set', function store(messagesSet) {
      for (const message of messagesSet.messages) {
        const jid = message.key.remoteJid?.decodeJid?.()
        if (!jid || isJidBroadcast(jid)) continue
        if (!(jid in messages)) messages[jid] = []
        upsertMessage(jid, proto.WebMessageInfo.fromObject(message), 'prepend')
      }
    })

    ev.on('contacts.update', function store(contactsUpdate) {
      for (const contact of contactsUpdate) {
        const id = contact.id?.decodeJid?.()
        if (!id) continue
        chats[id] = Object.assign(chats[id] || {}, { id, ...contact, isContact: true })

        const lid = contact.lid || contact.linkedIdentity
        if (lid && lid.endsWith('@lid') && id.endsWith('@s.whatsapp.net')) {
          if (!chats[lid]) chats[lid] = {}
          chats[lid].number = id
          chats[lid].lid = lid
          console.log(`[Store] contacts.update LID mapping: ${lid} → ${id}`)
        }
      }
    })

    ev.on('chats.upsert', async function store(chatsUpsert) {
      await Promise.all(chatsUpsert.map(async (chat) => {
        const id = chat.id?.decodeJid?.()
        if (!id || isJidBroadcast(id)) return
        if (!(id in chats)) chats[id] = { id, ...chat, isChats: true }
        const isGroup = isJidGroup(id)
        Object.assign(chats[id], { ...chat, isChats: true })
        if (isGroup && !chats[id].metadata) {
          const meta = await fetchGroupMetadata(id, opts.groupMetadata)
          Object.assign(chats[id], { metadata: meta })
          if (meta?.participants) cachePnFromParticipants(meta.participants)
        } else if (isGroup && chats[id].metadata?.participants) {
          cachePnFromParticipants(chats[id].metadata.participants)
        }
      }))
    })

    ev.on('chats.update', function store(chatsUpdate) {
      for (const chat of chatsUpdate) {
        const id = chat.id?.decodeJid?.()
        if (!id) continue
        if (!(id in chats)) chats[id] = { id, ...chat, isChats: true }
        if (chat.unreadCount) chat.unreadCount += chats[id].unreadCount || 0
        Object.assign(chats[id], { id, ...chat, isChats: true })
      }
    })

    ev.on('presence.update', function store(presenceUpdate) {
      const id = presenceUpdate.id?.decodeJid?.()
      if (!id) return
      if (!(id in chats)) chats[id] = { id, isContact: true }
      Object.assign(chats[id], presenceUpdate)
    })

    ev.on('messages.upsert', function store(messagesUpsert) {
      const { messages: newMessages, type } = messagesUpsert
      switch (type) {
        case 'append':
        case 'notify':
          for (const msg of newMessages) {
            const jid = msg.key.remoteJid?.decodeJid?.()
            if (!jid || isJidBroadcast(jid)) continue
            if (msg.messageStubType == WAMessageStubType.CIPHERTEXT) continue
            if (!(jid in messages)) messages[jid] = []
            upsertMessage(jid, proto.WebMessageInfo.fromObject(msg))

            if (type === 'notify' && !(jid in chats))
              ev.emit('chats.upsert', [{
                id: jid,
                conversationTimestamp: msg.messageTimestamp,
                unreadCount: 1,
                name: msg.pushName || msg.verifiedBizName,
              }])

            try {
              const content = msg.message?.pollUpdateMessage
                ? msg.message
                : (msg.message?.ephemeralMessage?.message?.pollUpdateMessage ? msg.message.ephemeralMessage.message : null)
              const pollUpdate = content?.pollUpdateMessage
              if (pollUpdate && opts.conn?.user?.id) {
                const creationMsgKey = pollUpdate.pollCreationMessageKey
                const creationJid = creationMsgKey?.remoteJid?.decodeJid?.() || jid
                const pollMsg = loadMessage(creationJid, creationMsgKey?.id)
                const pollEncKey = pollMsg?.message?.messageContextInfo?.messageSecret
                    || pollMsg?.messageContextInfo?.messageSecret
                if (pollMsg && pollEncKey) {
                  const meId = jidNormalizedUser(opts.conn.user.id)
                  const pollCreatorJid = getKeyAuthor(creationMsgKey, meId)
                  const voterJid = getKeyAuthor(msg.key, meId)
                  try {
                    const voteMsg = decryptPollVote(pollUpdate.vote, {
                      pollEncKey: pollEncKey.type === 'Buffer' ? Buffer.from(pollEncKey.data) : pollEncKey,
                      pollCreatorJid,
                      pollMsgId: creationMsgKey.id,
                      voterJid,
                    })
                    const selectedOptions = (voteMsg?.selectedOptions || []).map(o =>
                      Buffer.isBuffer(o) ? o.toString('hex') : Buffer.from(o?.data || o).toString('hex')
                    )
                    const pollOptions = pollMsg?.message?.pollCreationMessage?.options
                        || pollMsg?.message?.pollCreationMessageV2?.options
                        || pollMsg?.message?.pollCreationMessageV3?.options
                        || []
                    const optionNames = selectedOptions.map(hash => {
                      const match = pollOptions.find(o => crypto.createHash('sha256').update(o.optionName || '').digest('hex') === hash)
                      return match?.optionName || null
                    }).filter(Boolean)

                    const existing = pollMsg.pollUpdates || []
                    existing.push({
                      pollUpdateMessageKey: msg.key,
                      vote: voteMsg,
                      voter: voterJid,
                      selectedOptions: optionNames,
                      senderTimestampMs: pollUpdate.senderTimestampMs?.toNumber?.() ?? pollUpdate.senderTimestampMs
                    })
                    pollMsg.pollUpdates = existing
                    const pollJidMessages = messages[creationJid]
                    if (pollJidMessages) {
                      const idx = pollJidMessages.findIndex(m => m.key.id === creationMsgKey.id)
                      if (idx !== -1) pollJidMessages[idx].pollUpdates = existing
                    }
                  } catch (decErr) {
                  }
                }
              }
            } catch (pollErr) {
            }
          }
          break
      }
    })

    ev.on('messages.update', function store(messagesUpdate) {
      for (const message of messagesUpdate) {
        const jid = message.key.remoteJid?.decodeJid?.()
        if (!jid || isJidBroadcast(jid)) continue
        const id = message.key.id
        if (!(jid in messages)) messages[jid] = []
        const msg = loadMessage(jid, id)
        if (!msg) return
        if (message.update.messageStubType == WAMessageStubType.REVOKE) continue
        const msgIndex = messages[jid].findIndex(m => m.key.id === id)
        Object.assign(messages[jid][msgIndex], message.update)
      }
    })

    ev.on('groups.update', async function store(groupsUpdate) {
      await Promise.all(groupsUpdate.map(async (group) => {
        const id = group.id?.decodeJid?.()
        if (!id || !isJidGroup(id)) return
        if (!(id in chats)) chats[id] = { id, ...group, isChats: true }
        if (!chats[id].metadata) {
          const meta = await fetchGroupMetadata(id, opts.groupMetadata)
          Object.assign(chats[id], { metadata: meta })
          if (meta?.participants) cachePnFromParticipants(meta.participants)
        }
        Object.assign(chats[id].metadata, group)
        if (chats[id].metadata?.participants) cachePnFromParticipants(chats[id].metadata.participants)
      }))
    })

    ev.on('group-participants.update', async function store(groupParticipantsUpdate) {
      const id = groupParticipantsUpdate.id?.decodeJid?.()
      if (!id || !isJidGroup(id)) return
      if (!(id in chats)) chats[id] = { id }
      if (!chats[id].metadata) Object.assign(chats[id], { metadata: await fetchGroupMetadata(id, opts.groupMetadata) })
      const metadata = chats[id].metadata
      if (!metadata) return console.log(`Try to update group ${id} but metadata not found in 'group-participants.update'`)
      switch (groupParticipantsUpdate.action) {
        case 'add':
          metadata.participants.push(...groupParticipantsUpdate.participants.map(id => ({ id, admin: null })))
          cachePnFromParticipants(groupParticipantsUpdate.participants.map(id =>
            typeof id === 'object' ? id : { id }
          ))
          break
        case 'demote':
        case 'promote':
          for (const participant of metadata.participants)
            if (groupParticipantsUpdate.participants.includes(participant.id))
              participant.admin = groupParticipantsUpdate.action === 'promote' ? 'admin' : null
          break
        case 'remove':
          metadata.participants = metadata.participants.filter(p => !groupParticipantsUpdate.participants.includes(p.id))
          break
      }
      Object.assign(chats[id], { metadata })
    })

    ev.on('message-receipt.update', function store(messageReceiptUpdate) {
      for (const { key, receipt } of messageReceiptUpdate) {
        const jid = key.remoteJid?.decodeJid?.()
        if (!jid) continue
        if (!(jid in messages)) messages[jid] = []
        const msg = loadMessage(jid, key.id)
        if (!msg) return
        updateMessageWithReceipt(msg, receipt)
      }
    })

    ev.on('messages.reaction', function store(reactions) {
      for (const { key, reaction } of reactions) {
        const jid = key.remoteJid?.decodeJid?.()
        if (!jid) continue
        const msg = loadMessage(jid, key.id)
        if (!msg) return
        updateMessageWithReaction(msg, reaction)
      }
    })
  }

  function toJSON() {
    return { chats, messages }
  }

  function fromJSON(json) {
    Object.assign(chats, json.chats)
    for (const jid in json.messages)
      messages[jid] = json.messages[jid]
        .map(m => m && proto.WebMessageInfo.fromObject(m))
        .filter(m => m && m.messageStubType != WAMessageStubType.CIPHERTEXT)
  }

  let storeDb = null
  function getStoreDb(dbPath) {
    if (storeDb) return storeDb
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    storeDb = new DatabaseSync(dbPath)
    storeDb.exec(`
      CREATE TABLE IF NOT EXISTS store (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
    `)
    return storeDb
  }

  function writeToFile(dbPath) {
    const conn = getStoreDb(dbPath)
    const json = JSON.stringify(toJSON(), (key, value) => key == 'isChats' ? undefined : value)
    conn.prepare('INSERT INTO store (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(json)
  }

  function readFromFile(dbPath) {
    const conn = getStoreDb(dbPath)
    const row = conn.prepare('SELECT data FROM store WHERE id = 1').get()
    if (row) fromJSON(JSON.parse(row.data))
  }

  return {
    chats,
    messages,
    state,

    loadMessage,
    fetchGroupMetadata,
    getContact,
    getNumberFromLid,
    getLidFromNumber,

    bind,
    writeToFile,
    readFromFile
  }
}

function JSONreplacer(key, value) {
  if (value == null) return
  return BufferJSON.replacer(key, value)
}

const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

const KEY_MAP = {
  'pre-key': 'preKeys',
  'session': 'sessions',
  'sender-key': 'senderKeys',
  'app-state-sync-key': 'appStateSyncKeys',
  'app-state-sync-version': 'appStateVersions',
  'sender-key-memory': 'senderKeyMemory',
  'lid-mapping': 'lidMappings',
  'device-list': 'deviceLists',
  'tctoken': 'tcTokens'
}

function safeErr(err) {
  if (err instanceof Error) return err.stack || err.message
  return typeof err === 'string' ? err : (err?.message || String(err))
}

function applyCustomPairingCodePatch(creds) {
  const raw = global.settings?.connection?.main?.paircode
  if (!raw) return null

  const sanitized = String(raw).trim().toUpperCase()

  if (sanitized.length !== 8) {
    console.warn(
      chalk.yellow('[CUSTOM_PAIRING]'),
      `Ignored: must be exactly 8 characters (got ${sanitized.length}). Falling back to random pairing code.`
    )
    return null
  }

  if (creds && typeof creds === 'object') {
    creds.pairingCode = sanitized
  }
  return sanitized
}

function useSQLiteAuthState(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS creds (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS keys (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (type, id)
    );
  `)

  const clearAuthKeys = () => {
    const result = db.prepare('DELETE FROM keys').run()
    return result.changes
  }

  const readCreds = () => {
    const row = db.prepare('SELECT data FROM creds WHERE id = 1').get()
    return row ? JSON.parse(row.data, BufferJSON.reviver) : initAuthCreds()
  }

  const writeCreds = (creds) => {
    db.prepare('INSERT INTO creds (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(JSON.stringify(creds, JSONreplacer))
  }

  let creds = readCreds()

  const getStmt = db.prepare('SELECT data FROM keys WHERE type = ? AND id = ?')
  const setStmt = db.prepare('INSERT INTO keys (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data')
  const delStmt = db.prepare('DELETE FROM keys WHERE type = ? AND id = ?')

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === type) || type

          const lockKeys = ids.map(id => `${dbType}:${id}`)
          return signalKeyLock.runMany(lockKeys, async () => {
            const result = {}
            for (const id of ids) {
              const row = getStmt.get(dbType, id)
              if (row) result[id] = JSON.parse(row.data, BufferJSON.reviver)
            }
            return result
          })
        },
        set: async (data) => {
          const lockKeys = []
          for (const category in data) {
            const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
            for (const id in data[category]) lockKeys.push(`${dbType}:${id}`)
          }
          return signalKeyLock.runMany(lockKeys, async () => {
            for (const category in data) {
              const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
              for (const id in data[category]) {
                const value = data[category][id]
                if (value) setStmt.run(dbType, id, JSON.stringify(value, JSONreplacer))
                else delStmt.run(dbType, id)
              }
            }
          })
        }
      }
    },
    saveCreds: async () => writeCreds(creds),
    clearAuthKeys
  }
}

function useSingleFileAuthState(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const readAll = () => {
    if (!fs.existsSync(filePath)) return { creds: initAuthCreds(), keys: {} }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'), BufferJSON.reviver)
      return { creds: parsed.creds || initAuthCreds(), keys: parsed.keys || {} }
    } catch (e) {
      console.warn('Single-file auth state failed to parse, starting fresh:', e.message)
      return { creds: initAuthCreds(), keys: {} }
    }
  }

  let { creds, keys } = readAll()

  const persist = () => {
    fs.writeFileSync(filePath, JSON.stringify({ creds, keys }, JSONreplacer))
  }

  const clearAuthKeys = () => {
    const count = Object.values(keys).reduce((sum, byType) => sum + Object.keys(byType).length, 0)
    keys = {}
    persist()
    return count
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === type) || type
          const lockKeys = ids.map(id => `${dbType}:${id}`)
          return signalKeyLock.runMany(lockKeys, async () => {
            const result = {}
            for (const id of ids) {
              const raw = keys[dbType]?.[id]
              if (raw !== undefined) result[id] = raw
            }
            return result
          })
        },
        set: async (data) => {
          const lockKeys = []
          for (const category in data) {
            const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
            for (const id in data[category]) lockKeys.push(`${dbType}:${id}`)
          }
          return signalKeyLock.runMany(lockKeys, async () => {
            for (const category in data) {
              const dbType = Object.keys(KEY_MAP).find(k => KEY_MAP[k] === category) || category
              if (!keys[dbType]) keys[dbType] = {}
              for (const id in data[category]) {
                const value = data[category][id]
                if (value) keys[dbType][id] = value
                else delete keys[dbType][id]
              }
            }
            persist()
          })
        }
      }
    },
    saveCreds: async () => persist(),
    clearAuthKeys
  }
}

async function resolveAuthState(type, relativePath) {
  const baseDir = path.join(process.cwd(), 'data', 'sessions')

  if (type === 'multi') {
    const dir = path.join(baseDir, relativePath)
    fs.mkdirSync(dir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(dir)

    const clearAuthKeys = () => {
      const entries = fs.readdirSync(dir).filter(f => f !== 'creds.json')
      for (const f of entries) fs.unlinkSync(path.join(dir, f))
      return entries.length
    }
    return { state, saveCreds, clearAuthKeys }
  }

  if (type === 'single') {
    return useSingleFileAuthState(path.join(baseDir, `${relativePath}.json`))
  }

  return useSQLiteAuthState(path.join(baseDir, `${relativePath}.session`))
}

const rl       = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))

const authState = await resolveAuthState(global.settings.connection?.main?.type || 'sql', 'main')

const store     = makeInMemoryStore()
const storeFile = 'data/sessions/store.db'

try {
  store.readFromFile(storeFile)
} catch (e) {
  console.warn('Store failed to read store file, starting with empty store:', e.message)
}

const logger = Helper.P({
  level: 'silent',
  timestamp: () => `,"time":"${new Date().toJSON()}"`
}).child({ class: 'baileys' })

async function fetchVersionWithTimeout(timeoutMs = 8000) {
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('version fetch timeout')), timeoutMs))
    ])
    return result
  } catch (e) {
    console.warn(chalk.yellow('Baileys version fetch failed, using bundled default:'), safeErr(e))
    return { version: undefined, isLatest: false }
  }
}

const { version, isLatest } = await fetchVersionWithTimeout()

const connectionOptions = {
  printQRInTerminal: false,
  auth: authState.state,
  logger,
  version,
  browser: global.settings.connection.main.browser,
  connectTimeoutMs: 60000,
  keepAliveIntervalMs: 15000,
  retryRequestDelayMs: 500,
  syncFullHistory: !!global.settings.connection.main.loadhistory,
  markOnlineOnConnect: !!global.settings.system.online,
}

let pairingCodeRequested = false
let isReconnecting = false
let isPairingInProgress = false
let connGeneration = 0
let conns = new Map();

const extraConnectionListeners = new Set()

function onConnectionUpdate(handler) {
  extraConnectionListeners.add(handler)
  return () => extraConnectionListeners.delete(handler)
}

async function start(oldSocket = null, opts = { store, logger, authState }) {
  connGeneration++
  const myGeneration = connGeneration

  applyCustomPairingCodePatch(opts.authState.state.creds)

  let conn = makeWASocket({
    ...connectionOptions,
    ...opts.connectionOptions,
    logger: opts.logger,
    auth: {
      creds: opts.authState.state.creds,
      keys: makeCacheableSignalKeyStore(opts.authState.state.keys, opts.logger),
    },
    generateHighQualityLinkPreview: true,
    defaultQueryTimeoutMs: undefined,
    getMessage: async (key) => {
      const found = opts.store.loadMessage(key.remoteJid, key.id) || opts.store.loadMessage(key.id)
      return found?.message ?? undefined
    },
    patchMessageBeforeSending: (message) => {
      const requiresPatch = !!(
        message.buttonsMessage ||
        message.templateMessage ||
        message.listMessage
      )
      if (requiresPatch) {
        message = {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
              },
              ...message,
            },
          },
        }
      }
      return message
    },
  })

  conn.profilePictureUrl = async (jid, type = 'preview', timeoutMs) => {
    const targetJid = conn.decodeJid ? conn.decodeJid(jid) : jid
    const result = await conn.query(
      {
        tag: 'iq',
        attrs: {
          target: targetJid,
          to: '@s.whatsapp.net',
          type: 'get',
          xmlns: 'w:profile:picture',
        },
        content: [{ tag: 'picture', attrs: { type, query: 'url' } }],
      },
      timeoutMs
    )
    const child = result?.content?.find?.(n => n.tag === 'picture')
    return child?.attrs?.url
  }

  conn.generation = myGeneration

  HelperConnection(conn, { store: opts.store, logger })

  if (oldSocket) {
    conn.isInit       = oldSocket.isInit
    conn.isReloadInit = oldSocket.isReloadInit
  }
  if (conn.isInit == null) {
    conn.isInit       = false
    conn.isReloadInit = true
  }

  store.bind(conn.ev, { groupMetadata: conn.groupMetadata, conn })

  await reload(conn, false, opts)

  return conn
}

let OldHandler = null

async function reload(conn, restartConnection, opts = { store, authState }) {
  if (!opts.handler) opts.handler = Helper.importFile(Helper.__filename(resolve('./lib/utils/handler.js'))).catch(err => console.error(safeErr(err)))
  if (opts.handler instanceof Promise) opts.handler = await opts.handler
  if (!opts.handler && OldHandler) opts.handler = OldHandler
  OldHandler = opts.handler

  const isReloadInit = !!conn.isReloadInit
  if (restartConnection) {
    try {
      const ws = conn.ws?.socket ?? conn.ws
      if (ws && ws.readyState !== ws.CLOSED) {
        await new Promise(resolve => {
          const done = () => resolve()
          ws.once?.('close', done)
          conn.ws.close()
          setTimeout(done, 2000)
        })
      } else {
        conn.ws.close()
      }
    } catch {}
    conn.ev.removeAllListeners()

    await new Promise(resolve => setTimeout(resolve, 3000))

    Object.assign(conn, await start(conn, opts) || {})
    return true
  }

  Object.assign(conn, getMessageConfig())

  if (conn.handler)            conn.ev.off('messages.upsert', conn.handler)
  if (conn.participantsUpdate) conn.ev.off('group-participants.update', conn.participantsUpdate)
  if (conn.groupsUpdate)       conn.ev.off('groups.update', conn.groupsUpdate)
  if (conn.onDelete)           conn.ev.off('messages.delete', conn.onDelete)
  if (conn.connectionUpdate)   conn.ev.off('connection.update', conn.connectionUpdate)
  if (conn.credsUpdate)        conn.ev.off('creds.update', conn.credsUpdate)

  if (opts.handler) {
    const rawHandler = opts.handler.handler.bind(conn)
    const startEpoch = Math.floor(Date.now() / 1000)

    conn.handler = async (chatUpdate) => {
      if (chatUpdate?.messages) {
        chatUpdate.messages = chatUpdate.messages.filter((msg) => {
          const ts = typeof msg.messageTimestamp === 'object'
            ? msg.messageTimestamp?.low
            : msg.messageTimestamp
          return !ts || ts >= startEpoch
        })
        if (chatUpdate.messages.length === 0) return
      }
      return rawHandler(chatUpdate)
    }

    conn.participantsUpdate = opts.handler.participantsUpdate.bind(conn)
    conn.groupsUpdate       = opts.handler.groupsUpdate.bind(conn)
    conn.onDelete           = opts.handler.deleteUpdate.bind(conn)
  }

  if (!opts.isChild) conn.connectionUpdate = connectionUpdate.bind(conn, opts)
  conn.credsUpdate = opts.authState.saveCreds.bind(conn)

  if (conn.handler)            conn.ev.on('messages.upsert', conn.handler)
  if (conn.participantsUpdate) conn.ev.on('group-participants.update', conn.participantsUpdate)
  if (conn.groupsUpdate)       conn.ev.on('groups.update', conn.groupsUpdate)
  if (conn.onDelete)           conn.ev.on('messages.delete', conn.onDelete)
  if (!opts.isChild) {
    if (conn.connectionUpdate) conn.ev.on('connection.update', conn.connectionUpdate)
  }
  if (typeof conn.credsUpdate === 'function') conn.ev.on('creds.update', conn.credsUpdate)

  conn.isReloadInit = false
  return true
}

async function connectionUpdate(opts, update) {
  const { connection, lastDisconnect, isNewLogin, qr } = update

  if (connection) {
    console.log(`Connection` + chalk.gray(` ${connection}`))
  }

  for (const listener of extraConnectionListeners) {
    try {
      listener(update)
    } catch (err) {
      console.error(chalk.red('connection.update listener error:'), safeErr(err))
    }
  }

  if (connection === 'open') {
    this.isSocketReady = false
    setTimeout(() => { this.isSocketReady = true }, 3000)
  }
  if (connection === 'close') {
    this.isSocketReady = false
  }

  const mainConn = global.settings.connection.main
  const qrOnlyMode = !!(mainConn && mainConn.qr)

  if (qr && qrOnlyMode) {
    // qr:true di config -> tampilkan QR saja, tidak minta nomor/pairing code
    generateQR(qr, { small: true }, (output) => {
      console.log('\n' + output)
    })
  }

  if (qr && !qrOnlyMode && !pairingCodeRequested && !isPairingInProgress) {
    pairingCodeRequested = true
    isPairingInProgress = true
    const myGeneration = this.generation

    ;(async () => {
      try {
        console.log(chalk.yellow('\nSocket ready, requesting pairing code from WhatsApp...'))

        const pairFlag  = Helper.opts['pair']
        const phoneNumber = pairFlag
          ? String(pairFlag).trim()
          : (await question('Enter your WhatsApp number (example: 1305xxxx):\n')).trim()

        if (myGeneration !== connGeneration) {
          console.warn(chalk.yellow('Pairing cancelled, connection was replaced'))
          return
        }

        const customPairing = String(global.settings.connection.main.paircode).trim().toUpperCase()

        const pairingCode = await this.requestPairingCode(phoneNumber, customPairing)

        if (myGeneration !== connGeneration) {
          console.warn(chalk.yellow('Pairing cancelled, connection was replaced'))
          return
        }

        if (pairingCode) {
          const formattedCode = pairingCode.length === 8
            ? `${pairingCode.slice(0, 4)}-${pairingCode.slice(4)}`
            : pairingCode
          console.log(chalk.bold(`~> ${formattedCode}`))
        } else {
          console.warn(chalk.yellow('Did not receive pairing code, please try again'))
          pairingCodeRequested = false
        }
      } catch (error) {
        console.error(chalk.red('Error getting pairing code:'), safeErr(error))
        console.log('• Make sure the WhatsApp number is correct and try again.')
        pairingCodeRequested = false
      } finally {
        isPairingInProgress = false
      }
    })()
  }

  const code = lastDisconnect?.error?.output?.statusCode
    || lastDisconnect?.error?.output?.payload?.statusCode

  if (connection === 'close') {
    const reasonMsg = lastDisconnect?.error?.output?.payload?.message
      || lastDisconnect?.error?.message
      || '(no message)'
    console.log(chalk.red('[ DisconnectReal ]') + chalk.gray(` code=${code} message=${reasonMsg}`))
  }

  const NON_RECOVERABLE = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.badSession,
    DisconnectReason.connectionReplaced,
    DisconnectReason.forbidden,
    DisconnectReason.multideviceMismatch,
  ])

  const shouldReconnect = connection === 'close' && !NON_RECOVERABLE.has(code)

  if (shouldReconnect) {
    if (isReconnecting) {
      console.log(chalk.yellow('Reconnect') + chalk.gray(' is running, skip...'))
      return
    }
    if (isPairingInProgress && this.generation === connGeneration) {
      console.log(chalk.yellow('Reconnect') + chalk.gray(' delayed, pairing in progress...'))
      return
    }
    isReconnecting = true

    try {
      const retryDelay = code === DisconnectReason.connectionLost ? 1000 : 3000
      await new Promise(resolve => setTimeout(resolve, retryDelay))
      await reload(this, true, opts).catch(err => console.error(chalk.red('Reload error:'), safeErr(err)))

      if (global?.timestamp) global.timestamp.connect = new Date()

      pairingCodeRequested = false
    } finally {
      isReconnecting = false
    }
  }

  if (connection === 'open') {
    isReconnecting = false

    const onBotOpen = global.onBotOpen
    if (typeof onBotOpen === 'function') {
      global.onBotOpen = null
      Promise.resolve().then(onBotOpen).catch(e => console.error('Tunnel setup error:', safeErr(e)))
    }

    setTimeout(() => {
      global.restartTunnel?.().catch(e => console.error('Tunnel restartTunnel error:', safeErr(e)))
    }, 5000)
  }

  if (db.data == null) {
    await loadDatabase().catch(e => console.error('DB loadDatabase error:', safeErr(e)))
  }
}

async function forceReconnect(conn, opts, reason = 'forced') {
  if (isReconnecting) {
    console.log(chalk.yellow('Reconnect') + chalk.gray(' is running, skip... (forced trigger ignored)'))
    return false
  }
  if (isPairingInProgress) {
    console.log(chalk.yellow('Reconnect') + chalk.gray(' delayed, pairing in progress... (forced trigger ignored)'))
    return false
  }
  isReconnecting = true
  console.log(chalk.red('Reconnect') + chalk.gray(` forcing reload (reason: ${reason})`))
  const MAX_ATTEMPTS = 3
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      try {
        await reload(conn, true, opts)
        if (global?.timestamp) global.timestamp.connect = new Date()
        pairingCodeRequested = false
        return true
      } catch (err) {
        console.error(chalk.red('Reload error:') + chalk.gray(` (attempt ${attempt}/${MAX_ATTEMPTS})`), safeErr(err))
        if (attempt === MAX_ATTEMPTS) {
          console.error(chalk.red('Reconnect') + chalk.gray(` gave up after ${MAX_ATTEMPTS} failed attempts — falling back to a full process restart.`))
          setTimeout(() => process.emit('force-exit-for-restart'), 200)
          return false
        }
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
      }
    }
  } finally {
    isReconnecting = false
  }
}

function getMessageConfig() {
  return {
    welcome:  'Hi @user!\nWelcome to @subject',
    bye:      'Good bye @user!',
    spromote: '@user is now admin',
    sdemote:  '@user is no longer admin',
    sDesc:    'Description changed\n\n@desc',
    sSubject: 'Group subject changed\n\n@subject',
    sIcon:    'Group icon changed',
    sRevoke:  'Group link has been changed'
  }
}

const conn = start(null, { store, logger, authState })
  .catch(err => console.error(chalk.red('Start error:'), safeErr(err)))

conn.then(async () => {
  if (db.data == null) {
    await loadDatabase().catch(e => console.error('DB loadDatabase error:', safeErr(e)))
  }
  import('../../plugins/subbot/connect.js')
    .then(({ autoConnectSubBots }) => autoConnectSubBots())
    .catch(err => console.error('[Subbot] Autoconnect error:', safeErr(err)))
})

function sessionStoragePath(type, relativePath) {
  const baseDir = path.join(process.cwd(), 'data', 'sessions')
  if (type === 'multi') return path.join(baseDir, relativePath)
  if (type === 'single') return path.join(baseDir, `${relativePath}.json`)
  return path.join(baseDir, `${relativePath}.session`)
}

function hasSavedAuthState(type, relativePath) {
  const target = sessionStoragePath(type, relativePath)
  if (!fs.existsSync(target)) return false
  try {
    if (type === 'multi') {
      const credsFile = path.join(target, 'creds.json')
      if (!fs.existsSync(credsFile)) return false
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'), BufferJSON.reviver)
      return !!creds?.registered
    }
    if (type === 'single') {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'), BufferJSON.reviver)
      return !!parsed?.creds?.registered
    }
    const db = new DatabaseSync(target, { readOnly: true })
    const row = db.prepare('SELECT data FROM creds WHERE id = 1').get()
    db.close()
    if (!row) return false
    return !!JSON.parse(row.data, BufferJSON.reviver)?.registered
  } catch {
    return false
  }
}

function removeSavedAuthState(type, relativePath) {
  const target = sessionStoragePath(type, relativePath)
  if (!fs.existsSync(target)) return
  if (type === 'multi') {
    fs.rmSync(target, { recursive: true, force: true })
  } else {
    fs.rmSync(target, { force: true })
  }
}

export default {
  start,
  reload,
  forceReconnect,
  onConnectionUpdate,
  conn,
  conns,
  logger,
  connectionOptions,
  storeFile,
  authState,
  store,
  getMessageConfig,
  resolveAuthState,
  sessionStoragePath,
  hasSavedAuthState,
  removeSavedAuthState,
  generateQR
}

export { conn, conns, logger, forceReconnect, onConnectionUpdate, resolveAuthState, sessionStoragePath, hasSavedAuthState, removeSavedAuthState, generateQR }