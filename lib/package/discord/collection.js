export class Collection extends Map {
  first(count) {
    if (count === undefined) return this.values().next().value
    return [...this.values()].slice(0, count)
  }

  last(count) {
    const values = [...this.values()]
    if (count === undefined) return values.at(-1)
    return values.slice(Math.max(values.length - count, 0))
  }

  firstKey() {
    return this.keys().next().value
  }

  lastKey() {
    return [...this.keys()].at(-1)
  }

  keyArray() {
    return [...this.keys()]
  }

  toArray() {
    return [...this.values()]
  }

  filter(fn) {
    const out = new Collection()
    for (const [key, value] of this) if (fn(value, key, this)) out.set(key, value)
    return out
  }

  find(fn) {
    for (const [key, value] of this) if (fn(value, key, this)) return value
    return undefined
  }

  findKey(fn) {
    for (const [key, value] of this) if (fn(value, key, this)) return key
    return undefined
  }

  map(fn) {
    return [...this.entries()].map(([key, value]) => fn(value, key, this))
  }

  some(fn) {
    for (const [key, value] of this) if (fn(value, key, this)) return true
    return false
  }

  every(fn) {
    for (const [key, value] of this) if (!fn(value, key, this)) return false
    return true
  }

  reduce(fn, initial) {
    let acc = initial
    for (const [key, value] of this) acc = fn(acc, value, key, this)
    return acc
  }

  each(fn) {
    for (const [key, value] of this) fn(value, key, this)
    return this
  }

  sort(compare = (a, b) => (a > b ? 1 : a < b ? -1 : 0)) {
    const out = new Collection()
    const entries = [...this.entries()].sort(([, a], [, b]) => compare(a, b))
    for (const [key, value] of entries) out.set(key, value)
    return out
  }

  random(count) {
    const values = [...this.values()]
    if (count === undefined) return values.length ? values[Math.floor(Math.random() * values.length)] : undefined
    const pool = [...values]
    const picked = []
    while (pool.length && picked.length < count) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
    }
    return picked
  }

  clone() {
    return new Collection([...this.entries()])
  }
}
