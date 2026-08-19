import axios from 'axios'
import * as cheerio from 'cheerio'

const MAX_RETRY_ATTEMPTS = 3
const RETRY_INTERVAL = 333

function _deepFindAll(obj, key, out) {
    if (obj === null || typeof obj !== 'object') return out
    if (Array.isArray(obj)) {
        for (const el of obj) _deepFindAll(el, key, out)
        return out
    }
    for (const k of Object.keys(obj)) {
        if (k === key) out.push(obj[k])
        _deepFindAll(obj[k], key, out)
    }
    return out
}

function _allValues(obj, out) {
    if (obj === null || obj === undefined) return out
    if (typeof obj !== 'object') {
        out.push(obj)
        return out
    }
    if (Array.isArray(obj)) {
        for (const el of obj) _allValues(el, out)
        return out
    }
    for (const k of Object.keys(obj)) _allValues(obj[k], out)
    return out
}

function _parseJpPath(path) {
    let p = path.trim()
    if (p.startsWith('$')) p = p.slice(1)
    const steps = []
    const re = /\.\.([a-zA-Z0-9_$]+|\*)|\.(\*)|\.([a-zA-Z0-9_$]+)|\[(\d+)\]|\.\[\?\([^)]*\)\]/g
    let m
    while ((m = re.exec(p))) {
        if (m[1] !== undefined) {
            steps.push({ type: 'deep', key: m[1] })
        } else if (m[2] !== undefined) {
            steps.push({ type: 'children' })
        } else if (m[3] !== undefined) {
            steps.push({ type: 'child', key: m[3] })
        } else if (m[4] !== undefined) {
            steps.push({ type: 'index', index: Number(m[4]) })
        } else {
            steps.push({ type: 'filter' })
        }
    }
    return steps
}

function _runJpSteps(json, steps) {
    let current = [json]

    for (const step of steps) {
        const next = []

        if (step.type === 'deep') {
            for (const node of current) {
                if (step.key === '*') {
                    _allChildren(node, next)
                } else {
                    _deepFindAll(node, step.key, next)
                }
            }
        } else if (step.type === 'children') {
            for (const node of current) _allChildren(node, next)
        } else if (step.type === 'child') {
            for (const node of current) {
                if (node && typeof node === 'object' && step.key in node) {
                    next.push(node[step.key])
                }
            }
        } else if (step.type === 'index') {
            for (const node of current) {
                if (Array.isArray(node) && node[step.index] !== undefined) {
                    next.push(node[step.index])
                }
            }
        } else if (step.type === 'filter') {
            for (const node of current) next.push(node)
        }

        current = next
        if (current.length === 0) break
    }

    return current
}

function _allChildren(obj, out) {
    if (!obj || typeof obj !== 'object') return out
    if (Array.isArray(obj)) {
        for (const el of obj) out.push(el)
    } else {
        for (const k of Object.keys(obj)) out.push(obj[k])
    }
    return out
}

function _toStr(val) {
    if (val === null || val === undefined) return ''
    if (typeof val === 'string') return val
    if (typeof val === 'number' || typeof val === 'boolean') return String(val)
    if (Array.isArray(val)) return val.map(_toStr).join('')
    if (typeof val === 'object') {
        if (typeof val.text === 'string') return val.text
        if (typeof val.simpleText === 'string') return val.simpleText
        if (typeof val.content === 'string') return val.content
        if (Array.isArray(val.runs)) return val.runs.map((r) => _toStr(r.text)).join('')
        return ''
    }
    return ''
}

function _jpQueryRaw(json, path) {
    const steps = _parseJpPath(path)
    return _runJpSteps(json, steps)
}

const _jp = {}
_jp.query = function (json, path) {
    return _jpQueryRaw(json, path)
}
_jp.value = function (json, path) {
    const r = _jpQueryRaw(json, path)
    return r[0]
}

function _hasPlaylistMetadataRow(item) {
    const partsArrays = _deepFindAll(item, 'metadataParts', [])
    for (const parts of partsArrays) {
        const part1 = Array.isArray(parts) ? parts[1] : undefined
        if (!part1) continue
        const texts = _deepFindAll(part1, 'text', [])
        for (const t of texts) {
            if (t && typeof t === 'object' && t.content === 'Playlist') return true
        }
        if (part1.content === 'Playlist') return true
    }
    return false
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) (yt-search; https://www.npmjs.com/package/yt-search)'
let _userAgent = DEFAULT_USER_AGENT

const TEMPLATES = {
    YT: 'https://youtube.com',
    SEARCH_DESKTOP: 'https://www.youtube.com/results'
}

function humanTime(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
    const intervals = [
        ['year', 31536000],
        ['month', 2592000],
        ['week', 604800],
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
        ['second', 1]
    ]
    if (seconds < 0) return 'in the future'
    for (const [label, secs] of intervals) {
        const count = Math.floor(seconds / secs)
        if (count >= 1) return `${count} ${label}${count > 1 ? 's' : ''} ago`
    }
    return 'just now'
}

function _getScripts(text) {
    const $ = cheerio.load(text)
    const scripts = $('script')
    let buffer = ''
    for (let i = 0; i < scripts.length; i++) {
        const el = scripts[i]
        const child = el && el.children[0]
        const data = child && child.data
        if (data) buffer += data + '\n'
    }
    return buffer
}

function _findLine(regex, text) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) return lines[i]
    }
    return ''
}

function _between(text, start, end) {
    const i = text.indexOf(start)
    const j = text.lastIndexOf(end)
    if (i < 0 || j < 0) return ''
    return text.slice(i, j + 1)
}

async function httpGet(uri, headers) {
    const res = await axios.get(uri, {
        headers,
        responseType: 'text',
        transformResponse: [(data) => data],
        validateStatus: () => true,
        decompress: true
    })
    return { status: res.status, body: res.data }
}

export function search(query, callback) {
    if (!callback) {
        return new Promise((resolve, reject) => {
            search(query, (err, data) => {
                if (err) return reject(err)
                resolve(data)
            })
        })
    }

    let _options
    if (typeof query === 'string') {
        _options = { query }
    } else {
        _options = query
    }

    _options._attempts = (_options._attempts || 0) + 1
    const retryOptions = Object.assign({}, _options)

    function callback_with_retry(err, data) {
        if (err) {
            if (_options._attempts > (_options.MAX_RETRY_ATTEMPTS || MAX_RETRY_ATTEMPTS)) {
                return callback(err, data)
            } else {
                const n = _options._attempts
                const wait_ms = Math.pow(2, n - 1) * (_options.RETRY_INTERVAL || RETRY_INTERVAL)
                setTimeout(() => { search(retryOptions, callback) }, wait_ms)
            }
        } else {
            return callback(err, data)
        }
    }

    if (_options.userAgent) _userAgent = _options.userAgent

    _options.search = _options.query || _options.search
    _options.original_search = _options.search

    if (_options.videoId) {
        return getVideoMetaData(_options, callback_with_retry)
    }

    if (_options.listId) {
        return getPlaylistMetaData(_options, callback_with_retry)
    }

    if (!_options.search) {
        return callback(Error('yt-search: no query given'))
    }

    getSearchResults(_options, callback_with_retry)
}

function _videoFilter(video, index, videos) {
    if (video.type !== 'video') return false
    const videoId = video.videoId
    const firstIndex = videos.findIndex((el) => videoId === el.videoId)
    return firstIndex === index
}

function _playlistFilter(result, index, results) {
    if (result.type !== 'list') return false
    const id = result.listId
    const firstIndex = results.findIndex((el) => id === el.listId)
    return firstIndex === index
}

function _channelFilter(result, index, results) {
    if (result.type !== 'channel') return false
    const url = result.url
    const firstIndex = results.findIndex((el) => url === el.url)
    return firstIndex === index
}

function _liveFilter(result, index, results) {
    if (result.type !== 'live') return false
    const videoId = result.videoId
    const firstIndex = results.findIndex((el) => videoId === el.videoId)
    return firstIndex === index
}

function _allFilter(result, index, results) {
    switch (result.type) {
        case 'video':
        case 'list':
        case 'channel':
        case 'live':
            break
        default:
            return false
    }
    const url = result.url
    const firstIndex = results.findIndex((el) => url === el.url)
    return firstIndex === index
}

async function getSearchResults(_options, callback) {
    const q = encodeURIComponent(_options.search).split(/\s+/)
    const hl = _options.hl || 'en'
    const gl = _options.gl || 'US'
    const category = _options.category || ''

    let pageStart = Number(_options.pageStart) || 1
    let pageEnd = Number(_options.pageEnd) || Number(_options.pages) || 1

    if (pageStart <= 0) {
        pageStart = 1
        if (pageEnd >= 1) pageEnd += 1
    }

    if (Number.isNaN(pageEnd)) {
        return callback('error: pageEnd must be a number')
    }

    _options.pageStart = pageStart
    _options.pageEnd = pageEnd
    _options.currentPage = _options.currentPage || pageStart

    let queryString = '?'
    queryString += 'search_query=' + q.join('+')
    if (queryString.indexOf('&hl=') === -1) queryString += '&hl=' + hl
    if (queryString.indexOf('&gl=') === -1) queryString += '&gl=' + gl
    if (category) queryString += '&category=' + category
    if (_options.sp) queryString += '&sp=' + _options.sp

    const uri = TEMPLATES.SEARCH_DESKTOP + queryString

    const headers = {
        'user-agent': _userAgent,
        'accept': 'text/html',
        'accept-encoding': 'gzip',
        'accept-language': 'en-US'
    }

    let res
    try {
        res = await httpGet(uri, headers)
    } catch (err) {
        return callback(err)
    }

    if (res.status !== 200) {
        return callback('http status: ' + res.status)
    }

    try {
        _parseSearchResultInitialData(res.body, (err, results) => {
            if (err) return callback(err)

            const list = results

            const videos = list.filter(_videoFilter)
            const playlists = list.filter(_playlistFilter)
            const channels = list.filter(_channelFilter)
            const live = list.filter(_liveFilter)
            const all = list.filter(_allFilter)

            _options._data = _options._data || {}
            _options._data.videos = _options._data.videos || []
            _options._data.playlists = _options._data.playlists || []
            _options._data.channels = _options._data.channels || []
            _options._data.live = _options._data.live || []
            _options._data.all = _options._data.all || []

            videos.forEach((item) => _options._data.videos.push(item))
            playlists.forEach((item) => _options._data.playlists.push(item))
            channels.forEach((item) => _options._data.channels.push(item))
            live.forEach((item) => _options._data.live.push(item))
            all.forEach((item) => _options._data.all.push(item))

            _options.currentPage++
            const getMoreResults = _options.currentPage <= _options.pageEnd

            if (getMoreResults && results._sp) {
                _options.sp = results._sp
                setTimeout(() => { getSearchResults(_options, callback) }, 2500)
            } else {
                const videos = _options._data.videos.filter(_videoFilter)
                const playlists = _options._data.playlists.filter(_playlistFilter)
                const channels = _options._data.channels.filter(_channelFilter)
                const live = _options._data.live.filter(_liveFilter)
                const all = _options._data.all.filter(_allFilter)

                callback(null, {
                    all,
                    videos,
                    live,
                    playlists,
                    lists: playlists,
                    accounts: channels,
                    channels
                })
            }
        })
    } catch (err) {
        callback(err)
    }
}

function _parseSearchResultInitialData(responseText, callback) {
    const re = /{.*}/
    const $ = cheerio.load(responseText)

    let initialData = $('div#initial-data').html() || ''
    initialData = re.exec(initialData) || ''

    if (!initialData) {
        const scripts = $('script')
        for (let i = 0; i < scripts.length; i++) {
            const script = $(scripts[i]).html()
            const lines = script.split('\n')
            lines.forEach((line) => {
                let i
                while ((i = line.indexOf('ytInitialData')) >= 0) {
                    line = line.slice(i + 'ytInitialData'.length)
                    const match = re.exec(line)
                    if (match && match.length > initialData.length) {
                        initialData = match
                    }
                }
            })
        }
    }

    if (!initialData) {
        return callback('could not find inital data in the html document')
    }

    const errors = []
    const results = []

    const json = JSON.parse(initialData[0])
    let items = _jp.query(json, '$..itemSectionRenderer..contents.*')

    _jp.query(json, '$..primaryContents..contents.*').forEach((item) => {
        items.push(item)
    })

    for (let i = 0; i < items.length; i++) {
        const item = items[i]

        let result
        let type = 'unknown'

        const hasList = (
            _jp.value(item, '$..compactPlaylistRenderer') ||
            _jp.value(item, '$..playlistRenderer') ||
            _hasPlaylistMetadataRow(item)
        )

        const hasChannel = (
            _jp.value(item, '$..compactChannelRenderer') ||
            _jp.value(item, '$..channelRenderer')
        )

        const hasVideo = (
            _jp.value(item, '$..compactVideoRenderer') ||
            _jp.value(item, '$..videoRenderer')
        )

        const listId = hasList && (_jp.value(item, '$..watchEndpoint..playlistId'))
        const channelId = hasChannel && (_jp.value(item, '$..channelId'))
        const videoId = hasVideo && (_jp.value(item, '$..videoId'))

        const watchingLabel = (_jp.query(item, '$..viewCountText..text')).join('')

        const isUpcoming = (
            _jp.query(item, '$..thumbnailOverlayTimeStatusRenderer..style').join('').toUpperCase().trim() === 'UPCOMING'
        )

        const isLive = (
            watchingLabel.indexOf('watching') >= 0 ||
            (_jp.query(item, '$..badges..label').join('').toUpperCase().trim() === 'LIVE NOW') ||
            (_jp.query(item, '$..thumbnailOverlayTimeStatusRenderer..text').join('').toUpperCase().trim() === 'LIVE') ||
            isUpcoming
        )

        if (videoId) type = 'video'
        if (channelId) type = 'channel'
        if (listId) type = 'list'
        if (isLive) type = 'live'

        try {
            switch (type) {
                case 'video': {
                    const thumbnail = (
                        _normalizeThumbnail(_jp.value(item, '$..thumbnail..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnails..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnails'))
                    )

                    const title = (
                        _jp.value(item, '$..title..text') ||
                        _jp.value(item, '$..title..simpleText')
                    )

                    const author_name = (
                        _jp.value(item, '$..shortBylineText..text') ||
                        _jp.value(item, '$..longBylineText..text')
                    )

                    const author_url = (
                        _jp.value(item, '$..shortBylineText..url') ||
                        _jp.value(item, '$..longBylineText..url')
                    )

                    const agoText = (
                        _jp.value(item, '$..publishedTimeText..text') ||
                        _jp.value(item, '$..publishedTimeText..simpleText')
                    )

                    const viewCountText = (
                        _jp.value(item, '$..viewCountText..text') ||
                        _jp.value(item, '$..viewCountText..simpleText') || '0'
                    )

                    const viewsCount = Number(viewCountText.split(/\s+/)[0].split(/[,.]/).join('').trim())

                    const lengthText = (
                        _jp.value(item, '$..lengthText..text') ||
                        _jp.value(item, '$..lengthText..simpleText')
                    )
                    const duration = _parseDuration(lengthText || '0:00')

                    const description = (
                        (_jp.query(item, '$..detailedMetadataSnippets..snippetText..text')).join('') ||
                        (_jp.query(item, '$..description..text')).join('') ||
                        (_jp.query(item, '$..descriptionSnippet..text')).join('')
                    )

                    const url = TEMPLATES.YT + '/watch?v=' + videoId

                    result = {
                        type: 'video',
                        videoId,
                        url,
                        title: _toStr(title).trim(),
                        description,
                        image: thumbnail,
                        thumbnail,
                        seconds: Number(duration.seconds),
                        timestamp: duration.timestamp,
                        duration,
                        ago: agoText,
                        views: Number(viewsCount),
                        author: {
                            name: author_name,
                            url: TEMPLATES.YT + author_url
                        }
                    }
                    break
                }

                case 'list': {
                    const thumbnail = (
                        _normalizeThumbnail(_jp.value(item, '$..primaryThumbnail..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnail..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnails..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnails'))
                    )

                    const title = (
                        _jp.value(item, '$..metadata..title..content') ||
                        _jp.value(item, '$..title..text') ||
                        _jp.value(item, '$..title..simpleText')
                    )

                    const author_name = (
                        _jp.value(item, '$..metadataParts[0]..text..content') ||
                        _jp.value(item, '$..shortBylineText..text') ||
                        _jp.value(item, '$..longBylineText..text') ||
                        _jp.value(item, '$..shortBylineText..simpleText') ||
                        _jp.value(item, '$..longBylineText..simpleTextn')
                    ) || 'YouTube'

                    const author_url = (
                        _jp.value(item, '$..metadataParts[0]..url') ||
                        _jp.value(item, '$..shortBylineText..url') ||
                        _jp.value(item, '$..longBylineText..url')
                    ) || ''

                    const video_count_label = _jp.value(item, '$..overlays..thumbnailBadges..text')

                    const video_count = (
                        _jp.value(item, '$..videoCountShortText..text') ||
                        _jp.value(item, '$..videoCountText..text') ||
                        _jp.value(item, '$..videoCountShortText..simpleText') ||
                        _jp.value(item, '$..videoCountText..simpleText') ||
                        _jp.value(item, '$..thumbnailText..text') ||
                        _jp.value(item, '$..thumbnailText..simpleText')
                    )

                    const url = TEMPLATES.YT + '/playlist?list=' + listId

                    result = {
                        type: 'list',
                        listId,
                        url,
                        title: _toStr(title).trim(),
                        image: thumbnail,
                        thumbnail,
                        videoCount: (
                            Number(_parseNumbers(video_count_label)[0]) ||
                            video_count
                        ),
                        author: {
                            name: author_name,
                            url: TEMPLATES.YT + author_url
                        }
                    }
                    break
                }

                case 'channel': {
                    const thumbnail = (
                        _normalizeThumbnail(_jp.value(item, '$..thumbnail..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnails..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnails'))
                    )

                    const title = (
                        _jp.value(item, '$..title..text') ||
                        _jp.value(item, '$..title..simpleText') ||
                        _jp.value(item, '$..displayName..text')
                    )

                    const channelId = _jp.value(item, '$..channelRenderer..channelId') || ''

                    const author_name = (
                        _jp.value(item, '$..shortBylineText..text') ||
                        _jp.value(item, '$..longBylineText..text') ||
                        _jp.value(item, '$..displayName..text') ||
                        _jp.value(item, '$..displayName..simpleText')
                    )

                    let about_channel = (
                        (_jp.query(item, '$..channelRenderer..descriptionSnippet..text')).join('') || ''
                    )

                    let video_count_label = (
                        _jp.value(item, '$..videoCountText..simpleText') ||
                        _jp.value(item, '$..videoCountText..label') ||
                        _jp.value(item, '$..videoCountText..text') || '0'
                    )

                    let channel_verified_label = (
                        _jp.value(item, '$..channelRenderer..ownerBadges..style') ||
                        _jp.value(item, '$..channelRenderer..ownerBadges..tooltip') ||
                        _jp.value(item, '$..channelRenderer..ownerBadges..label') || ''
                    )
                    const channel_verified = (
                        channel_verified_label.toLowerCase().trim().search(/[\s_]?verified/) >= 0
                    )

                    let sub_count_label = (
                        _jp.value(item, '$..subscriberCountText..simpleText') ||
                        _jp.value(item, '$..subscriberCountText..text') || '0'
                    )

                    if (typeof sub_count_label === 'string') {
                        if (sub_count_label.indexOf('subscribe') < 1) {
                            if (video_count_label.indexOf('subscribe') > 0) {
                                sub_count_label = video_count_label
                                video_count_label = '-1'
                            }
                        }

                        sub_count_label = (
                            sub_count_label.split(/\s+/)
                                .filter((w) => w.match(/\d/))
                        )[0]
                    }

                    const base_url = (
                        _jp.value(item, '$..navigationEndpoint..url') ||
                        _jp.value(item, '$..browseEndpoint..canonicalBaseUrl') ||
                        _jp.value(item, '$..browseEndpoint..url') ||
                        '/user/' + title
                    )

                    result = {
                        type: 'channel',
                        name: author_name,
                        url: TEMPLATES.YT + base_url,
                        baseUrl: base_url,
                        id: channelId,
                        title: _toStr(title).trim(),
                        about: about_channel,
                        image: thumbnail,
                        thumbnail,
                        videoCount: Number(_parseNumbers(video_count_label)[0]),
                        videoCountLabel: video_count_label,
                        verified: channel_verified,
                        subCount: _parseSubCountLabel(sub_count_label),
                        subCountLabel: sub_count_label
                    }
                    break
                }

                case 'live': {
                    const thumbnail = (
                        _normalizeThumbnail(_jp.value(item, '$..thumbnail..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnails..url')) ||
                        _normalizeThumbnail(_jp.value(item, '$..thumbnails'))
                    )

                    const title = (
                        _jp.value(item, '$..title..text') ||
                        _jp.value(item, '$..title..simpleText')
                    )

                    const author_name = (
                        _jp.value(item, '$..shortBylineText..text') ||
                        _jp.value(item, '$..longBylineText..text')
                    )

                    const author_url = (
                        _jp.value(item, '$..shortBylineText..url') ||
                        _jp.value(item, '$..longBylineText..url')
                    )

                    const watchingLabelLive = (
                        (_jp.query(item, '$..viewCountText..text')).join('') ||
                        (_jp.query(item, '$..viewCountText..simpleText')).join('') || '0'
                    )

                    const watchCount = Number(watchingLabelLive.split(/\s+/)[0].split(/[,.]/).join('').trim())

                    const description = (
                        (_jp.query(item, '$..detailedMetadataSnippets..snippetText..text')).join('') ||
                        (_jp.query(item, '$..description..text')).join('') ||
                        (_jp.query(item, '$..descriptionSnippet..text')).join('')
                    )

                    const scheduledEpochTime = _jp.value(item, '$..upcomingEventData..startTime')

                    const scheduledTime = (
                        (Date.now() > scheduledEpochTime) ? scheduledEpochTime * 1000 : scheduledEpochTime
                    )

                    const scheduledDateString = _toInternalDateString(scheduledTime)

                    const url = TEMPLATES.YT + '/watch?v=' + videoId

                    result = {
                        type: 'live',
                        videoId,
                        url,
                        title: _toStr(title).trim(),
                        description,
                        image: thumbnail,
                        thumbnail,
                        watching: Number(watchCount),
                        author: {
                            name: author_name,
                            url: TEMPLATES.YT + author_url
                        }
                    }

                    if (scheduledTime) {
                        result.startTime = scheduledTime
                        result.startDate = scheduledDateString
                        result.status = 'UPCOMING'
                    } else {
                        result.status = 'LIVE'
                    }
                    break
                }

                default:
                // ignore other stuff
            }

            if (result) results.push(result)
        } catch (err) {
            errors.push(err)
        }
    }

    const ctoken = _jp.value(json, '$..continuation')
    results._ctoken = ctoken

    if (errors.length) {
        return callback(errors.pop(), results)
    }

    return callback(null, results)
}

async function getVideoMetaData(opts, callback) {
    let videoId
    if (typeof opts === 'string') videoId = opts
    if (typeof opts === 'object') videoId = opts.videoId

    const { hl = 'en', gl = 'US' } = opts
    const uri = `https://www.youtube.com/watch?hl=${hl}&gl=${gl}&v=${videoId}`

    const headers = {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15',
        'accept': 'text/html',
        'accept-encoding': 'gzip',
        'accept-language': `${hl}-${gl}`
    }

    let res
    try {
        res = await httpGet(uri, headers)
    } catch (err) {
        return callback(err)
    }

    if (res.status !== 200) {
        return callback('http status: ' + res.status)
    }

    try {
        _parseVideoInitialData(res.body, callback)
    } catch (err) {
        callback(err)
    }
}

function _parseVideoInitialData(responseText, callback) {
    responseText = _getScripts(responseText)

    const initialData = _between(
        _findLine(/ytInitialData.*=\s*{/, responseText), '{', '}'
    )

    if (!initialData) {
        return callback('could not find inital data in the html document')
    }

    const initialPlayerData = _between(
        _findLine(/ytInitialPlayerResponse.*=\s*{/, responseText), '{', '}'
    )

    if (!initialPlayerData) {
        return callback('could not find inital player data in the html document')
    }

    let idata = JSON.parse(initialData)
    let ipdata = JSON.parse(initialPlayerData)

    const videoId = _jp.value(idata, '$..currentVideoEndpoint..videoId')

    if (!videoId) {
        return callback('video unavailable')
    }

    if (
        _jp.value(ipdata, '$..status') === 'ERROR' ||
        _jp.value(ipdata, '$..reason') === 'Video unavailable'
    ) {
        return callback('video unavailable')
    }

    const title = _parseVideoMetaDataTitle(idata)

    const description = (
        (_jp.query(idata, '$..detailedMetadataSnippets..snippetText..text')).join('') ||
        (_jp.query(idata, '$..description..text')).join('') ||
        (_jp.query(ipdata, '$..description..simpleText')).join('') ||
        (_jp.query(ipdata, '$..microformat..description..simpleText')).join('') ||
        (_jp.query(ipdata, '$..videoDetails..shortDescription')).join('')
    )

    const author_name = (
        _jp.value(idata, '$..owner..title..text') ||
        _jp.value(idata, '$..owner..title..simpleText')
    )

    const author_url = (
        _jp.value(idata, '$..owner..navigationEndpoint..url') ||
        _jp.value(idata, '$..owner..title..url')
    )

    const thumbnailUrl = 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg'

    const seconds = Number(_jp.value(ipdata, '$..videoDetails..lengthSeconds'))

    const timestamp = _msToTimestamp(seconds * 1000)

    const duration = _parseDuration(timestamp)

    const uploadDate = (
        _jp.value(idata, '$..uploadDate') ||
        _jp.value(idata, '$..dateText..simpleText')
    )

    const agoText = uploadDate && humanTime(new Date(uploadDate)) || ''

    const video = {
        title,
        description,
        url: TEMPLATES.YT + '/watch?v=' + videoId,
        videoId,
        seconds: Number(duration.seconds),
        timestamp: duration.timestamp,
        duration,
        views: Number(_jp.value(ipdata, '$..videoDetails..viewCount')),
        genre: (_jp.value(ipdata, '$..category') || '').toLowerCase(),
        uploadDate: _toInternalDateString(uploadDate),
        ago: agoText,
        image: thumbnailUrl,
        thumbnail: thumbnailUrl,
        author: {
            name: author_name,
            url: TEMPLATES.YT + author_url
        }
    }

    if (!video.description || !video.timestamp || !video.seconds || !video.views) {
        let q = `${video.title}`
        while (q && q[0].match(/[-]/)) q = q.slice(1)

        setTimeout(() => {
            search({
                query: q,
                options: { RETRY_INTERVAL: 1000 }
            }, (err, r) => {
                if (err) return callback(err)
                if (!r.videos) return callback(null, video)
                for (let i = 0; i < r.videos.length; i++) {
                    const v = r.videos[i]
                    if (!v) continue
                    if (video.videoId != null && video.videoId === v?.videoId) {
                        Object.keys(video).forEach((key) => {
                            video[key] = v[key] || video[key]
                        })
                        break
                    }
                }
                callback(err, video)
            })
        }, 1500)
    } else {
        callback(null, video)
    }
}

async function getPlaylistMetaData(opts, callback) {
    let listId
    if (typeof opts === 'string') listId = opts
    if (typeof opts === 'object') listId = opts.listId || opts.playlistId

    const { hl = 'en', gl = 'US' } = opts
    const uri = `https://www.youtube.com/playlist?hl=${hl}&gl=${gl}&list=${listId}`

    const headers = {
        'user-agent': _userAgent,
        'accept': 'text/html',
        'accept-encoding': 'gzip',
        'accept-language': `${hl}-${gl}`
    }

    let res
    try {
        res = await httpGet(uri, headers)
    } catch (err) {
        return callback(err)
    }

    if (res.status !== 200) {
        return callback('http status: ' + res.status)
    }

    try {
        _parsePlaylistInitialData(res.body, callback)
    } catch (err) {
        callback(err)
    }
}

function _parsePlaylistInitialData(responseText, callback) {
    responseText = _getScripts(responseText)

    const match = responseText.match(/ytInitialData.*=\s*({.*});/)
    const jsonString = match && match[1]

    if (!jsonString) {
        throw new Error('failed to parse ytInitialData json data')
    }

    let json = JSON.parse(jsonString)

    const plerr = _jp.value(json, '$..alerts..alertRenderer')
    if (plerr && (typeof plerr.type === 'string') && plerr.type.toLowerCase() === 'error') {
        let plerrtext = 'playlist error, not found?'
        if (typeof plerr.text === 'object') {
            plerrtext = _jp.query(plerr.text, '$..text').join('')
        }
        if (typeof plerr.text === 'string') {
            plerrtext = plerr.text
        }
        throw new Error('playlist error: ' + plerrtext)
    }

    let alertInfo = ''
    _jp.query(json, '$..alerts..text').forEach((val) => {
        if (typeof val === 'string') alertInfo += val
        if (typeof val === 'object') {
            const simpleText = _jp.value(val, '$..simpleText')
            if (simpleText) alertInfo += simpleText
        }
    })

    const listId = (_jp.value(json, '$..microformat..urlCanonical') || '').split('=')[1]

    let viewCount = 0
    try {
        const viewCountLabel = _jp.value(json, '$..sidebar.playlistSidebarRenderer.items[0]..stats[1].simpleText')
        if (viewCountLabel.toLowerCase() === 'no views') {
            viewCount = 0
        } else {
            viewCount = viewCountLabel.match(/\d+/g).join('')
        }
    } catch (err) { /* ignore */ }

    const size = (
        _jp.value(json, '$..sidebar.playlistSidebarRenderer.items[0]..stats[0].simpleText') ||
        _jp.query(json, '$..sidebar.playlistSidebarRenderer.items[0]..stats[0]..text').join('')
    ).match(/\d+/g).join('')

    const list = _jp.query(json, '$..playlistVideoListRenderer..contents')[0]

    const videos = []

    list.forEach((item) => {
        if (!item.playlistVideoRenderer) return

        const json = item

        const duration = (
            _parseDuration(
                _jp.value(json, '$..lengthText..simpleText') ||
                _jp.value(json, '$..thumbnailOverlayTimeStatusRenderer..simpleText') ||
                (_jp.query(json, '$..lengthText..text')).join('') ||
                (_jp.query(json, '$..thumbnailOverlayTimeStatusRenderer..text')).join('')
            )
        )

        const video = {
            title: (
                _jp.value(json, '$..title..simpleText') ||
                _jp.value(json, '$..title..text') ||
                (_jp.query(json, '$..title..text')).join('')
            ),
            videoId: _jp.value(json, '$..videoId'),
            listId,
            thumbnail: (
                _normalizeThumbnail(_jp.value(json, '$..thumbnail..url')) ||
                _normalizeThumbnail(_jp.value(json, '$..thumbnails..url')) ||
                _normalizeThumbnail(_jp.value(json, '$..thumbnails'))
            ),
            duration,
            author: {
                name: _jp.value(json, '$..shortBylineText..runs[0]..text'),
                url: 'https://youtube.com' + _jp.value(json, '$..shortBylineText..runs[0]..url')
            }
        }

        videos.push(video)
    })

    const plthumbnail = (
        _normalizeThumbnail(_jp.value(json, '$..microformat..thumbnail..url')) ||
        _normalizeThumbnail(_jp.value(json, '$..microformat..thumbnails..url')) ||
        _normalizeThumbnail(_jp.value(json, '$..microformat..thumbnails'))
    )

    const playlist = {
        title: _jp.value(json, '$..microformat..title'),
        listId,
        url: 'https://youtube.com/playlist?list=' + listId,
        size: Number(size),
        views: Number(viewCount),
        date: _parsePlaylistLastUpdateTime(
            (_jp.value(json, '$..sidebar.playlistSidebarRenderer.items[0]..stats[2]..simpleText')) ||
            (_jp.query(json, '$..sidebar.playlistSidebarRenderer.items[0]..stats[2]..text')).join('') ||
            ''
        ),
        image: plthumbnail || (videos[0] && videos[0].thumbnail),
        thumbnail: plthumbnail || (videos[0] && videos[0].thumbnail),
        videos,
        alertInfo,
        author: {
            name: _jp.value(json, '$..videoOwner..title..runs[0]..text'),
            url: 'https://youtube.com' + _jp.value(json, '$..videoOwner..navigationEndpoint..url')
        }
    }

    callback && callback(null, playlist)
}

function _parsePlaylistLastUpdateTime(lastUpdateLabel) {
    const DAY_IN_MS = (1000 * 60 * 60 * 24)

    try {
        const words = lastUpdateLabel.toLowerCase().trim().split(/[\s.-]+/)

        if (words.length > 0) {
            const lastWord = (words[words.length - 1]).toLowerCase()
            if (lastWord === 'yesterday') {
                const ms = Date.now() - DAY_IN_MS
                const d = new Date(ms)
                if (d.toString() !== 'Invalid Date') return _toInternalDateString(d)
            }
        }

        if (words.length >= 2) {
            if (words[0] === 'updated' && words[2].slice(0, 3) === 'day') {
                const ms = Date.now() - (DAY_IN_MS * words[1])
                const d = new Date(ms)
                if (d.toString() !== 'Invalid Date') return _toInternalDateString(d)
            }
        }

        for (let i = 0; i < words.length; i++) {
            const slice = words.slice(i)
            const t = slice.join(' ')
            const r = slice.reverse().join(' ')

            const a = new Date(t)
            const b = new Date(r)

            if (a.toString() !== 'Invalid Date') return _toInternalDateString(a)
            if (b.toString() !== 'Invalid Date') return _toInternalDateString(b)
        }

        return ''
    } catch (err) { return '' }
}

function _toInternalDateString(date) {
    date = new Date(date)
    return (
        date.getFullYear() + '-' +
        (date.getMonth() + 1) + '-' +
        date.getDate()
    )
}

function _parseDuration(timestampText) {
    const a = timestampText.split(/\s+/)
    const lastword = a[a.length - 1]

    let timestamp = lastword.replace(/[^:.\d]/g, '')

    if (!timestamp) return {
        toString: () => a[0],
        seconds: 0,
        timestamp: 0
    }

    while (timestamp[timestamp.length - 1]?.match(/\D/)) {
        timestamp = timestamp.slice(0, -1)
    }

    timestamp = timestamp.replace(/\./g, ':')

    const t = timestamp.split(/[:.]/)

    let seconds = 0
    let exp = 0
    for (let i = t.length - 1; i >= 0; i--) {
        if (t[i].length <= 0) continue
        const number = t[i].replace(/\D/g, '')
        seconds += parseInt(number) * (exp > 0 ? Math.pow(60, exp) : 1)
        exp++
        if (exp > 2) break
    }

    return {
        toString: () => seconds + ' seconds (' + timestamp + ')',
        seconds,
        timestamp
    }
}

function _parseSubCountLabel(subCountLabel) {
    if (!subCountLabel) return undefined

    const label = (
        subCountLabel.split(/\s+/)
            .filter((w) => w.match(/\d/))
    )[0].toLowerCase()

    const m = label.match(/\d+(\.\d+)?/)
    if (!m || !m[0]) return
    const num = Number(m[0])

    const THOUSAND = 1000
    const MILLION = THOUSAND * THOUSAND

    if (label.indexOf('m') >= 0) return MILLION * num
    if (label.indexOf('k') >= 0) return THOUSAND * num
    return num
}

function _parseNumbers(label) {
    if (!label) return []

    const nums = (
        label.split(/\s+/)
            .filter((w) => w.match(/\d/))
            .map((l) => l.toLowerCase())
    )

    const results = []

    nums.forEach((n) => {
        const m = n.match(/[-]?\d+(\.\d+)?/)
        if (!m || !m[0]) return
        let num = Number(m[0])

        const THOUSAND = 1000
        const MILLION = THOUSAND * THOUSAND

        if (n.indexOf('m') >= 0) num = MILLION * num
        if (n.indexOf('k') >= 0) num = THOUSAND * num

        results.push(num)
    })

    return results
}

function _normalizeThumbnail(thumbnails) {
    if (!thumbnails) return undefined

    let t
    if (typeof thumbnails === 'string') {
        t = thumbnails
    } else {
        if (thumbnails.length) {
            t = thumbnails[0]
            return _normalizeThumbnail(t)
        }
        return undefined
    }

    t = t.split('?')[0]
    t = t.split('/default.jpg').join('/hqdefault.jpg')
    t = t.split('/default.jpeg').join('/hqdefault.jpeg')

    if (t.indexOf('//') === 0) {
        return 'https://' + t.slice(2)
    }

    return t.split('http://').join('https://')
}

function _msToTimestamp(ms) {
    let t = ''

    const MS_HOUR = 1000 * 60 * 60
    const MS_MINUTE = 1000 * 60
    const MS_SECOND = 1000

    const h = Math.floor(ms / MS_HOUR)
    const m = Math.floor(ms / MS_MINUTE) % 60
    const s = Math.floor(ms / MS_SECOND) % 60

    if (h) t += h + ':'
    if (h && String(m).length < 2) t += '0'
    t += m + ':'
    if (String(s).length < 2) t += '0'
    t += s

    return t
}

function _parseVideoMetaDataTitle(idata) {
    const t = (
        (_jp.query(idata, '$..videoPrimaryInfoRenderer.title..text')).join('') ||
        (_jp.query(idata, '$..videoPrimaryInfoRenderer.title..simpleText')).join('') ||
        (_jp.query(idata, '$..videoPrimaryRenderer.title..text')).join('') ||
        (_jp.query(idata, '$..videoPrimaryRenderer.title..simpleText')).join('') ||
        _jp.value(idata, '$..title..text') ||
        _jp.value(idata, '$..title..simpleText')
    )

    return t.replace(/[\u0000-\u001F\u007F-\u009F\u200b]/g, '')
}

export default search
