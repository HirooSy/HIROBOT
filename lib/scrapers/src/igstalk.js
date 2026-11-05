import axios from 'hiro/axios'
import * as cheerio from 'hiro/cheerio'

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const requestTimeout = 15000

const bioPattern = /on Instagram:\s*"(.*?)"\.?$/
const fullNamePattern = /["']full_name["']:\s*["'](.*?)["']/
const biographyPattern = /["']biography["']:\s*["'](.*?)["']/
const pkPattern = /["']pk["']:\s*["'](\d+)["']/
const userIdPattern = /["']user_id["']:\s*["'](\d+)["']/
const verifiedPattern = /["']is_verified["']:\s*true/
const privatePattern = /["']is_private["']:\s*true/
const externalUrlPattern = /["']external_url["']:\s*["'](.*?)["']/
const mediaNodePattern = /\{\s*"__typename":\s*"XIGPolaris(?:Image|Video)Media"[\s\S]*?"id":\s*"POLARIS_\d+"\}/g
const codePattern = /["']code["']:\s*["'](.*?)["']/
const nodePkPattern = /["']pk["']:\s*["'](.*?)["']/
const typeNamePattern = /["']__typename["']:\s*["'](.*?)["']/
const productTypePattern = /["']product_type["']:\s*["'](.*?)["']/
const displayUriPattern = /["']display_uri["']:\s*["'](.*?)["']/
const captionPattern = /["']caption["']:\s*\{\s*["']text["']:\s*["'](.*?)["']\s*\}/
const accessibilityPattern = /["']accessibility_caption["']:\s*["'](.*?)["']/
const storiesUserIdPattern = /USER_ID\s*=\s*(\d+)/

function cleanUsername(input) {
    if (!input) return ''
    let value = input.trim()
    if (value.includes('instagram.com/')) {
        value = value.split('instagram.com/')[1].split('/')[0].split('?')[0]
    }
    return value.replace(/^@+/, '').trim()
}

function firstGroup(text, pattern) {
    const match = text.match(pattern)
    return match ? match[1] : null
}

function decodeEscaped(raw) {
    try {
        return JSON.parse(`"${raw}"`)
    } catch {
        return raw
    }
}

function parseMediaNode(nodeText) {
    const code = firstGroup(nodeText, codePattern)
    if (!code) return null

    const productType = firstGroup(nodeText, productTypePattern) || 'feed'
    const typeName = firstGroup(nodeText, typeNamePattern) || ''
    const displayUri = firstGroup(nodeText, displayUriPattern)
    const captionRaw = firstGroup(nodeText, captionPattern)
    const accessibilityRaw = firstGroup(nodeText, accessibilityPattern)
    const postUrl = productType === 'clips'
        ? `https://www.instagram.com/reel/${code}/`
        : `https://www.instagram.com/p/${code}/`

    return {
        id: firstGroup(nodeText, nodePkPattern),
        code,
        url: postUrl,
        type: typeName.includes('Video') ? 'video' : 'image',
        product_type: productType,
        caption: captionRaw !== null ? decodeEscaped(captionRaw) : null,
        accessibility_caption: accessibilityRaw !== null ? decodeEscaped(accessibilityRaw) : null,
        thumbnail: displayUri !== null ? displayUri.replace(/\\\//g, '/').replace(/\\u0025/g, '%') : null
    }
}

function userWindow(html, user) {
    const index = html.indexOf(`"username":"${user.toLowerCase()}"`)
    return index === -1 ? '' : html.slice(Math.max(0, index - 6000), index + 6000)
}

function formatCount(value) {
    if (value === null || value === undefined) return null
    const text = String(value).replace(/[.,]$/, '').trim()
    return /^\d+$/.test(text) ? Number(text).toLocaleString('en-US') : text
}

function postFromJson(item) {
    if (!item || !item.shortcode) return null
    const productType = item.product_type || (item.is_video ? 'clips' : 'feed')
    return {
        id: item.id || null,
        code: item.shortcode,
        url: productType === 'clips'
            ? `https://www.instagram.com/reel/${item.shortcode}/`
            : `https://www.instagram.com/p/${item.shortcode}/`,
        type: item.is_video ? 'video' : 'image',
        product_type: productType,
        caption: item.edge_media_to_caption?.edges?.[0]?.node?.text ?? null,
        accessibility_caption: item.accessibility_caption || null,
        thumbnail: item.display_url || null
    }
}

async function fetchWebProfileInfo(user) {
    const node = (await axios.get(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(user)}`, {
        headers: {
            'User-Agent': userAgent,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': `https://www.instagram.com/${encodeURIComponent(user)}/`,
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: requestTimeout
    })).data?.data?.user
    if (!node) return null

    const posts = (node.edge_owner_to_timeline_media?.edges || [])
        .map(edge => postFromJson(edge?.node))
        .filter(Boolean)

    return {
        user: {
            id: node.id || null,
            username: node.username || user,
            full_name: node.full_name || node.username || user,
            biography: node.biography || '',
            external_url: node.external_url || null,
            profile_pic_url: node.profile_pic_url_hd || node.profile_pic_url || null,
            is_verified: !!node.is_verified,
            is_private: !!node.is_private,
            stats: {
                followers: formatCount(node.edge_followed_by?.count),
                following: formatCount(node.edge_follow?.count),
                posts: formatCount(node.edge_owner_to_timeline_media?.count)
            }
        },
        recent_posts: {
            count: posts.length,
            items: posts
        }
    }
}

function countOf(sources, patterns) {
    for (const source of sources) {
        for (const pattern of patterns) {
            const match = source.match(pattern)
            if (match) return formatCount(match[1])
        }
    }
    return null
}

async function fetchInstagramProfile(user) {
    const response = await axios.get(`https://www.instagram.com/${encodeURIComponent(user)}/`, {
        headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        },
        timeout: requestTimeout
    })

    const html = String(response.data)
    const page = cheerio.load(html)

    const ogTitle = page('meta[property="og:title"]').attr('content') || ''
    const ogDescription = page('meta[property="og:description"]').attr('content') || page('meta[name="description"]').attr('content') || ''
    const ogImage = page('meta[property="og:image"]').attr('content') || ''

    let fullName = ''
    let biography = ''

    const sources = [ogDescription, userWindow(html, user), html]
    const followerCount = countOf(sources, [
        /([\d.,]+\s?[KMBkmb]?)\s*followers/i,
        /["']edge_followed_by["']\s*:\s*\{\s*["']count["']\s*:\s*(\d+)/,
        /["']follower_count["']\s*:\s*(\d+)/
    ])
    const followingCount = countOf(sources, [
        /([\d.,]+\s?[KMBkmb]?)\s*following/i,
        /["']edge_follow["']\s*:\s*\{\s*["']count["']\s*:\s*(\d+)/,
        /["']following_count["']\s*:\s*(\d+)/
    ])
    const postsCount = countOf(sources, [
        /([\d.,]+\s?[KMBkmb]?)\s*posts/i,
        /["']edge_owner_to_timeline_media["']\s*:\s*\{\s*["']count["']\s*:\s*(\d+)/,
        /["']media_count["']\s*:\s*(\d+)/
    ])

    if (ogDescription) {
        const bioMatch = ogDescription.match(bioPattern)
        if (bioMatch) biography = bioMatch[1]
    }

    if (ogTitle) fullName = ogTitle.split('(@')[0].trim()

    const fullNameRaw = firstGroup(html, fullNamePattern)
    if (fullNameRaw !== null) fullName = decodeEscaped(fullNameRaw)

    const biographyRaw = firstGroup(html, biographyPattern)
    if (biographyRaw !== null && !biography) biography = decodeEscaped(biographyRaw)

    const userId = firstGroup(html, pkPattern) || firstGroup(html, userIdPattern)
    const isVerified = verifiedPattern.test(html)
    const isPrivate = privatePattern.test(html)

    const externalUrlRaw = firstGroup(html, externalUrlPattern)
    const externalUrl = externalUrlRaw !== null ? externalUrlRaw.replace(/\\/g, '') : null

    if (!fullName && !ogTitle && !userId) return null

    const mediaNodes = html.match(mediaNodePattern) || []
    const seenCodes = new Set()
    const posts = []
    for (const nodeText of mediaNodes) {
        const post = parseMediaNode(nodeText)
        if (!post || seenCodes.has(post.code)) continue
        seenCodes.add(post.code)
        posts.push(post)
    }

    return {
        user: {
            id: userId,
            username: user,
            full_name: fullName || user,
            biography: biography || '',
            external_url: externalUrl,
            profile_pic_url: ogImage || null,
            is_verified: isVerified,
            is_private: isPrivate,
            stats: {
                followers: followerCount,
                following: followingCount,
                posts: postsCount
            }
        },
        recent_posts: {
            count: posts.length,
            items: posts
        }
    }
}

async function fetchStoriesViewerProfile(user) {
    const response = await axios.get(`https://insta-stories-viewer.com/${encodeURIComponent(user)}/`, {
        headers: {
            'User-Agent': userAgent
        },
        timeout: requestTimeout
    })

    const html = String(response.data)
    const page = cheerio.load(html)
    const statsText = page('.profile__stats, .stats, .counts').text().replace(/\s+/g, ' ').trim()

    const postsCount = firstGroup(statsText, /([\d\.,KMkm]+)\s*Posts/i)
    const followerCount = firstGroup(statsText, /([\d\.,KMkm]+)\s*Followers/i)
    const followingCount = firstGroup(statsText, /([\d\.,KMkm]+)\s*Following/i)

    const avatar = page('.profile__avatar img, .avatar img, img[alt*="profile"]').attr('src') || page('img').first().attr('src') || null
    const fullName = page('.profile__name, .profile-title, h1').first().text().replace(/\(Anonymous profile view\)/gi, '').trim() || user
    const biography = page('.profile__bio, .bio, .description').text().trim()
    const userId = firstGroup(html, storiesUserIdPattern)

    return {
        user: {
            id: userId,
            username: user,
            full_name: fullName,
            biography,
            external_url: null,
            profile_pic_url: avatar,
            is_verified: false,
            is_private: false,
            stats: {
                followers: followerCount,
                following: followingCount,
                posts: postsCount
            }
        },
        recent_posts: {
            count: 0,
            items: []
        }
    }
}

export async function igStalk(username) {
    const user = cleanUsername(username)
    if (!user) {
        return {
            status: false,
            message: 'Instagram username is required!'
        }
    }

    let profile = null
    try {
        profile = await fetchWebProfileInfo(user)
    } catch {
        profile = null
    }
    if (!profile) {
        try {
            profile = await fetchInstagramProfile(user)
        } catch {
            profile = null
        }
    }
    if (profile) return { status: true, data: profile }

    try {
        const fallback = await fetchStoriesViewerProfile(user)
        return { status: true, data: fallback }
    } catch (error) {
        return {
            status: false,
            message: `Failed to fetch profile @${user}: ${error.message}`
        }
    }
}

export default igStalk
