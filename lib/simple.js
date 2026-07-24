// TODO: Make this file more redeable
import path from 'path'
import db from './database.js'
import { toAudio } from './tools/converter.js'
import fetch, { Response } from 'node-fetch'
import PhoneNumber from 'awesome-phonenumber'
import fs from 'fs'
import util from 'util'
const Jimp = (await import( 'jimp')).Jimp
import { fileURLToPath } from 'url'
import Connection from './connection.js'
import { Readable, PassThrough } from 'stream'
import crypto from 'crypto'
import Helper from './helper.js'
import {
    fileTypeFromBuffer,
    fileTypeStream
} from 'file-type'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** @type {typeof import('baileys')} */ // @ts-ignore
const {
    proto,
    downloadContentFromMessage,
    jidDecode,
    areJidsSameUser,
    generateForwardMessageContent,
    generateWAMessageFromContent,
    extractMessageContent,
    getContentType,
    toReadable,
    prepareWAMessageMedia,
    jidNormalizedUser,
} = await import('baileys')
/** 
 * @param {import('./connection').Socket} conn 
 * @param {{
 *  store: typeof import('./connection')['default']['store']
 *  logger: import('./connection.js').Logger
 * }} options
 */

// ================= AI Rich Message Toolkit (classes, module scope) =================
        // ================= AI Rich Message Toolkit (inlined) =================
// ================= extractIE =================
function extractIE(text, { extract = true, hyperlink = true, citation = true, latex = true } = {}) {
	if (!extract) {
		return {
			text,
			ie: [],
			inline_entities: [],
		};
	}

	const createIE = (type, ie) => {
		if (type == 'hyperlink') {
			return {
				key: ie.key,
				metadata: {
					display_name: ie.text,
					is_trusted: ie.is_trusted,
					url: ie.url,
					__typename: 'GenAIInlineLinkItem',
				},
			};
		}

		if (type == 'citation') {
			return {
				key: ie.key,
				metadata: {
					reference_id: ie.reference_id,
					reference_url: ie.url,
					reference_title: ie.url,
					reference_display_name: ie.url,
					sources: [],
					__typename: 'GenAISearchCitationItem',
				},
			};
		}

		if (type == 'latex') {
			return {
				key: ie.key,
				metadata: {
					latex_expression: ie.text,
					latex_image: {
						url: ie.url,
						width: Number(ie.width) || 100,
						height: Number(ie.height) || 100,
					},
					font_height: Number(ie.font_height) || 83.333333333333,
					padding: Number(ie.padding) || 15,
					__typename: 'GenAILatexItem',
				},
			};
		}
	};

	let ie = [];
	let inline_entities = [];
	let result = '';
	let last = 0;
	let citation_index = 1;
	let hyperlink_index = 0;
	let latex_index = 0;
	let stack = [];

	for (let i = 0; i < text.length; i++) {
		if (text[i] == '[' && text[i - 1] != '\\') {
			stack.push(i);
		} else if (text[i] == ']' && (text[i + 1] == '(' || text[i + 1] == '<')) {
			let start = stack.pop();

			if (start == null) continue;

			let open = text[i + 1];
			let close = open == '(' ? ')' : '>';
			let type = open == '(' ? 'link' : 'latex';
			let end = i + 2;
			let depth = 1;

			while (end < text.length && depth) {
				if (text[end] == open && text[end - 1] != '\\') depth++;
				else if (text[end] == close && text[end - 1] != '\\') depth--;
				end++;
			}

			if (depth) continue;

			let raw = text.slice(start + 1, i).trim();
			let url = text.slice(i + 2, end - 1).trim();

			let key;
			let tag;
			let data;

			if (type == 'latex') {
				if (!latex) continue;

				let [txt = '', width = null, height = null, font_height = null, padding = null] = raw.split('|');

				key = `\u004E\u0049\u0058\u0045\u004C_LATEX_${latex_index++}`;
				tag = `{{${key}}}${txt || 'image'}{{/${key}}}`;

				data = {
					type: 'latex',
					ie: {
						key,
						text: txt,
						url,
						width,
						height,
						font_height,
						padding,
					},
				};
			} else if (raw) {
				if (!hyperlink) continue;

				const trusted = !url.startsWith('!');

				if (!trusted) {
					url = url.slice(1);
				}

				key = `\u004E\u0049\u0058\u0045\u004C_HYPERLINK_${hyperlink_index++}`;
				tag = `{{${key}}}${url}{{/${key}}}`;

				data = {
					type: 'hyperlink',
					ie: {
						key,
						text: raw,
						url,
						is_trusted: trusted,
					},
				};
			} else {
				if (!citation) continue;

				key = `\u004E\u0049\u0058\u0045\u004C_CITATION_${citation_index - 1}`;
				tag = `{{${key}}}${url}{{/${key}}}`;

				data = {
					type: 'citation',
					ie: {
						reference_id: citation_index++,
						key,
						text: '',
						url,
					},
				};
			}

			result += text.slice(last, start) + tag;
			last = end;

			ie.push(data);

			const entity = createIE(data.type, data.ie);

			if (entity) {
				inline_entities.push(entity);
			}

			i = end - 1;
		}
	}

	result += text.slice(last);

	return {
		text: result,
		ie,
		inline_entities,
	};
}

// ================= waitAllPromises =================
async function waitAllPromises(input) {
	const isPromise = (v) => v && typeof v.then === 'function';
	const isObject = (v) => v && typeof v === 'object';

	const deep = async (v) => {
		if (isPromise(v)) return deep(await v);
		if (Array.isArray(v)) return Promise.all(v.map(deep));
		if (isObject(v)) {
			const entries = await Promise.all(Object.entries(v).map(async ([k, val]) => [k, await deep(val)]));
			return Object.fromEntries(entries);
		}
		return v;
	};

	return deep(await input);
}

// ================= Lazy optional deps (sharp & fluent-ffmpeg) =================
// Beberapa environment hosting gagal load native binding "sharp" (mis. libvips
// tidak cocok dengan platform). Supaya bot tidak crash total saat start hanya
// karena fitur resize/thumbnail AIRich, kedua modul ini di-import on-demand
// (lazy) dan dibungkus try-catch. Kalau gagal, error baru muncul saat fitur
// terkait dipakai, bukan saat bot pertama kali dijalankan.
let _sharp = null
let _sharpError = null
async function getSharp() {
	if (_sharp) return _sharp
	if (_sharpError) throw _sharpError
	try {
		_sharp = (await import('sharp')).default
		return _sharp
	} catch (err) {
		_sharpError = new Error(`Modul "sharp" gagal dimuat (fitur resize/thumbnail tidak tersedia): ${err.message}`)
		throw _sharpError
	}
}

let _ffmpeg = null
let _ffmpegError = null
async function getFfmpeg() {
	if (_ffmpeg) return _ffmpeg
	if (_ffmpegError) throw _ffmpegError
	try {
		_ffmpeg = (await import('fluent-ffmpeg')).default
		return _ffmpeg
	} catch (err) {
		_ffmpegError = new Error(`Modul "fluent-ffmpeg" gagal dimuat (fitur preview video tidak tersedia): ${err.message}`)
		throw _ffmpegError
	}
}

// ================= Toolkit =================
class Toolkit {
	constructor() {}

	static extractIE(text, { extract = true, hyperlink = true, citation = true, latex = true } = {}) {
		return extractIE(text, { extract, hyperlink, citation, latex });
	}

	static async resize(buffer, x, y, fit = 'cover') {
		const sharp = await getSharp()
		return await sharp(buffer)
			.resize(x, y, {
				fit,
				position: 'center',
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			})
			.png()
			.toBuffer();
	}

	static async waitAllPromises(input) {
		return await waitAllPromises(input);
	}

	static async fetchBuffer(url, options = {}, { silent = true } = {}) {
		try {
			let response = await fetch(url, options);
			if (!response.ok) throw Error(`HTTP ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		} catch (error) {
			if (silent) return Buffer.alloc(0);
			throw error;
		}
	}

	static async toUrl(_client, path, mediaType = 'document') {
		if (!path) throw new Error('Url or buffer needed');

		const media = await prepareWAMessageMedia(
			{
				[mediaType]: Buffer.isBuffer(path) ? path : { url: path },
			},
			{
				upload: _client.waUploadToServer,
				jid: '\u0040\u006e\u0065\u0077\u0073\u006c\u0065\u0074\u0074\u0065\u0072',
			}
		);

		return Object.values(media)[0]?.url;
	}

	static async resolveMedia(_client, media, mediaType = 'image', { resolveUrl = false, resolveWAUrl = false, result = 'url', resize = false, width = 300, height = 300 } = {}) {
		const isUrl = (str) => /^https?:\/\/.+/i.test(str);

		const isWAUrl = (str) => /^https?:\/\/[^/]*\.whatsapp\.net\//i.test(str);

		if (Array.isArray(media)) {
			return Promise.all(
				media.map((item) =>
					Toolkit.resolveMedia(_client, item, mediaType, {
						resolveUrl,
						resolveWAUrl,
						result,
						resize,
						width,
						height,
					})
				)
			);
		}

		const originalIsBuffer = Buffer.isBuffer(media);

		if (typeof media === 'string' && isUrl(media)) {
			if (isWAUrl(media)) {
				if (resolveWAUrl) {
					media = await Toolkit.fetchBuffer(media, {}, { silent: true });
				} else if (!resolveUrl) {
					if (result === 'url') return media;

					media = await Toolkit.fetchBuffer(media, {}, { silent: true });
				}
			} else {
				if (!resolveUrl) {
					if (result === 'url') return media;

					media = await Toolkit.fetchBuffer(media, {}, { silent: true });
				} else {
					media = await Toolkit.fetchBuffer(media, {}, { silent: true });
				}
			}
		}

		if (typeof media === 'string' && !isUrl(media)) {
			media = Buffer.from(media, 'base64');
		}

		if (!Buffer.isBuffer(media) || !media.length) {
			return;
		}

		if (resize && Buffer.isBuffer(media)) {
			media = await Toolkit.resize(media, width, height);
		}

		if (result === 'buffer') {
			return media;
		}

		if (result === 'base64') {
			return media.toString('base64');
		}

		if (originalIsBuffer) {
			return Toolkit.toUrl(_client, media, mediaType);
		}

		return Toolkit.toUrl(_client, media, mediaType);
	}

	static getMp4Duration(buffer, { silent = true } = {}) {
		try {
			if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
				if (silent) return 0;
				throw new Error('Invalid buffer');
			}

			let offset = 0;

			while (offset < buffer.length - 8) {
				const size = buffer.readUInt32BE(offset);

				if (size < 8 || offset + size > buffer.length) {
					if (silent) return 0;
					throw new Error('Invalid atom size');
				}

				const type = buffer.toString('ascii', offset + 4, offset + 8);

				if (type === 'moov') {
					let moovOffset = offset + 8;
					const moovEnd = offset + size;

					while (moovOffset < moovEnd - 8) {
						const childSize = buffer.readUInt32BE(moovOffset);

						if (childSize < 8 || moovOffset + childSize > moovEnd) {
							if (silent) return 0;
							throw new Error('Invalid child atom size');
						}

						const childType = buffer.toString('ascii', moovOffset + 4, moovOffset + 8);

						if (childType === 'mvhd') {
							const version = buffer.readUInt8(moovOffset + 8);

							if (version === 0) {
								const timescale = buffer.readUInt32BE(moovOffset + 20);
								const duration = buffer.readUInt32BE(moovOffset + 24);

								if (!timescale) {
									if (silent) return 0;
									throw new Error('Invalid timescale');
								}

								return duration / timescale;
							}

							if (version === 1) {
								const timescale = buffer.readUInt32BE(moovOffset + 32);
								const duration = Number(buffer.readBigUInt64BE(moovOffset + 36));

								if (!timescale) {
									if (silent) return 0;
									throw new Error('Invalid timescale');
								}

								return duration / timescale;
							}
						}

						moovOffset += childSize;
					}
				}

				offset += size;
			}

			if (silent) return 0;

			throw new Error('No mvhd found!');
		} catch (err) {
			if (silent) return 0;
			throw err;
		}
	}

	static getMp4Preview(videoBuffer, { time, result = 'buffer', resize = true, width = 300, height = 300, silent = true } = {}) {
		return new Promise((resolve, reject) => {
			const fail = (err) => {
				if (silent) {
					return resolve(result === 'base64' ? '' : Buffer.alloc(0));
				}
				return reject(err);
			};

			(async () => {
				try {
					if (!Buffer.isBuffer(videoBuffer) || !videoBuffer.length) {
						return fail(new Error('videoBuffer tidak valid atau kosong'));
					}

					const ffmpeg = await getFfmpeg()

					const inputStream = new Readable({ read() {} });
					inputStream.push(videoBuffer);
					inputStream.push(null);

					const outputStream = new PassThrough();
					const chunks = [];

					outputStream.on('data', (chunk) => chunks.push(chunk));

					outputStream.on('end', async () => {
						try {
							let output = Buffer.concat(chunks);

							if (!output.length) {
								return fail(new Error('Output kosong — cek format atau timestamp video'));
							}

							if (resize) {
								output = await Toolkit.resize(output, width, height);
							}

							return resolve(result === 'base64' ? output.toString('base64') : output);
						} catch (err) {
							return fail(err);
						}
					});

					outputStream.on('error', fail);

					time ??= Math.min(Toolkit.getMp4Duration(videoBuffer) * 0.2, 10);

					ffmpeg(inputStream)
						.outputOptions([`-ss ${time}`, '-vframes 1', '-vcodec png', '-f image2pipe'])
						.on('error', (err) => fail(new Error(`ffmpeg error: ${err.message}`)))
						.pipe(outputStream, { end: true });
				} catch (err) {
					return fail(err);
				}
			})();
		});
	}
}

// ================= BaseBuilder =================
class BaseBuilder {
	constructor() {
		this._title = '';
		this._subtitle = '';
		this._body = '';
		this._footer = '';
		this._contextInfo = {};
		this._extraPayload = {};
	}

	setTitle(title) {
		if (typeof title !== 'string') {
			throw new TypeError('Title must be a string');
		}
		this._title = title;
		return this;
	}

	setSubtitle(subtitle) {
		if (typeof subtitle !== 'string') {
			throw new TypeError('Subtitle must be a string');
		}
		this._subtitle = subtitle;
		return this;
	}

	setBody(body) {
		if (typeof body !== 'string') {
			throw new TypeError('Body must be a string');
		}
		this._body = body;
		return this;
	}

	setFooter(footer) {
		if (typeof footer !== 'string') {
			throw new TypeError('Footer must be a string');
		}
		this._footer = footer;
		return this;
	}

	setContextInfo(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('ContextInfo must be a plain object');
		}

		this._contextInfo = obj;
		return this;
	}

	addPayload(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('Payload must be a plain object');
		}

		Object.assign(this._extraPayload, obj);
		return this;
	}
}

// ================= AIRich =================
class AIRich extends BaseBuilder {
	#client;

	constructor(client) {
		if (!client) {
			throw new Error('Socket is required');
		}

		super();
		this.#client = client;
		this._contextInfo = {};
		this._submessages = [];
		this._sections = [];
		this._richResponseSources = [];
	}

	addSubmessage(submessage) {
		const items = Array.isArray(submessage) ? submessage : [submessage];

		for (const item of items) {
			if (typeof item !== 'object' || item === null || Array.isArray(item)) {
				throw new TypeError('Submessage must be a plain object or array of plain objects');
			}

			this._submessages.push(item);
		}

		return this;
	}

	addSection(section) {
		const items = Array.isArray(section) ? section : [section];

		for (const item of items) {
			if (typeof item !== 'object' || item === null || Array.isArray(item)) {
				throw new TypeError('Section must be a plain object or array of plain objects');
			}

			this._sections.push(item);
		}

		return this;
	}

	addText(text, { hyperlink = true, citation = true, latex = true } = {}) {
		if (typeof text != 'string') {
			throw new TypeError('Text must be a string');
		}

		const { text: extractedText, inline_entities } = extractIE(text, {
			hyperlink,
			citation,
			latex,
		});

		this._submessages.push({
			messageType: 2,
			messageText: extractedText,
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				text: extractedText,
				...(inline_entities.length && {
					inline_entities,
				}),
				__typename: 'GenAIMarkdownTextUXPrimitive',
			})
		);

		return this;
	}

	addCode(language, code) {
		if (typeof language !== 'string' || typeof code !== 'string') {
			throw new TypeError('Language and code must be a string');
		}

		const meta = AIRich.tokenizer(code, language);

		this._submessages.push({
			messageType: 5,
			codeMetadata: {
				codeLanguage: language,
				codeBlocks: meta.codeBlock,
			},
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				language,
				code_blocks: meta.unified_codeBlock,
				__typename: 'GenAICodeUXPrimitive',
			})
		);

		return this;
	}

	addTable(table, { hyperlink = true, citation = true, latex = true } = {}) {
		if (!Array.isArray(table)) {
			throw new TypeError('Table must be an array');
		}

		const meta = AIRich.toTableMetadata(table, { hyperlink, citation, latex });

		this._submessages.push({
			messageType: 4,
			tableMetadata: {
				title: meta.title,
				rows: meta.rows,
			},
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				rows: meta.unified_rows,
				__typename: 'GenATableUXPrimitive',
			})
		);

		return this;
	}

	addSource(sources = []) {
		if (!(Array.isArray(sources) && (sources.every((item) => typeof item === 'string') || sources.every((item) => Array.isArray(item) && item.every((v) => typeof v === 'string'))))) {
			throw new TypeError('Sources must be a string array or an array of string arrays');
		}

		if (sources.every((item) => typeof item === 'string')) {
			sources = [sources];
		}

		const source = sources.map(([icon, url, text]) => ({
			source_type: 'THIRD_PARTY',
			source_display_name: text ?? '',
			source_subtitle: 'AI',
			source_url: url ?? '',
			favicon: {
				url: Toolkit.resolveMedia(this.#client, icon ?? '', 'image'),
				mime_type: 'image/jpeg',
				width: 16,
				height: 16,
			},
		}));

		this._sections.push(
			AIRich.newLayout('Single', {
				sources: source,
				__typename: 'GenAISearchResultPrimitive',
			})
		);

		return this;
	}

	addReels(reelsItems = []) {
		if (
			!(
				(reelsItems && typeof reelsItems === 'object' && !Array.isArray(reelsItems)) ||
				(Array.isArray(reelsItems) && reelsItems.every((item) => item && typeof item === 'object' && !Array.isArray(item)))
			)
		) {
			throw new TypeError('Reels items must be an object or an array of objects');
		}

		if (!Array.isArray(reelsItems)) {
			reelsItems = [reelsItems];
		}

		const reels = reelsItems.map((item) => ({
			...item,
			_avatar: Toolkit.resolveMedia(this.#client, item.profileIconUrl ?? item.profile_url ?? item.profile ?? '', 'image'),
			_thumbnail: Toolkit.resolveMedia(this.#client, item.thumbnailUrl ?? item.thumbnail ?? '', 'image'),
		}));

		this._submessages.push({
			messageType: 9,
			contentItemsMetadata: {
				contentType: 1,
				itemsMetadata: reels.map((item) => ({
					reelItem: {
						title: item.username ?? '',
						profileIconUrl: item._avatar,
						thumbnailUrl: item._thumbnail,
						videoUrl: item.videoUrl ?? item.url ?? '',
					},
				})),
			},
		});

		reels.forEach((item, idx) => {
			this._richResponseSources.push({
				provider: '\u004E\u0049\u0058\u0045\u004C',
				thumbnailCDNURL: item._thumbnail,
				sourceProviderURL: item.videoUrl ?? item.url ?? '',
				sourceQuery: '',
				faviconCDNURL: item._avatar,
				citationNumber: idx + 1,
				sourceTitle: item.username ?? '',
			});
		});

		this._sections.push(
			AIRich.newLayout(
				'HScroll',
				reels.map((item) => ({
					reels_url: item.videoUrl ?? item.url ?? '',
					thumbnail_url: item._thumbnail,
					creator: item.username ?? item.title ?? '',
					avatar_url: item._avatar,
					reels_title: item.reels_title ?? item.title ?? '',
					likes_count: item.likes_count ?? item.like ?? 0,
					shares_count: item.shares_count ?? item.share ?? 0,
					view_count: item.view_count ?? item.view ?? 0,
					reel_source: item.reel_source ?? item.source ?? 'IG',
					is_verified: !!(item.is_verified || item.verified),
					__typename: 'GenAIReelPrimitive',
				}))
			)
		);

		return this;
	}

	addImage(imageUrl, { resolveUrl = false } = {}) {
		if (!(typeof imageUrl === 'string' || Buffer.isBuffer(imageUrl) || (Array.isArray(imageUrl) && imageUrl.every((v) => typeof v === 'string' || Buffer.isBuffer(v))))) {
			throw new TypeError('imageUrl must be string | buffer | array of string/buffer');
		}

		const list = Array.isArray(imageUrl)
			? imageUrl.map((v) => {
					const url = Toolkit.resolveMedia(this.#client, v, 'image', { resolveUrl });
					return {
						imagePreviewUrl: url,
						imageHighResUrl: url,
						sourceUrl: url,
					};
				})
			: (() => {
					const url = Toolkit.resolveMedia(this.#client, imageUrl, 'image', { resolveUrl });
					return [
						{
							imagePreviewUrl: url,
							imageHighResUrl: url,
							sourceUrl: url,
						},
					];
				})();

		this._submessages.push({
			messageType: 1,
			gridImageMetadata: {
				gridImageUrl: {
					imagePreviewUrl: list[0]?.imagePreviewUrl,
				},
				imageUrls: list,
			},
		});

		list.forEach(({ imagePreviewUrl }) => {
			this._sections.push(
				AIRich.newLayout('Single', {
					media: {
						url: imagePreviewUrl,
						mime_type: 'image/png',
					},
					imagine_type: 'IMAGE',
					status: { status: 'READY' },
					__typename: 'GenAIImaginePrimitive',
				})
			);
		});

		return this;
	}

	addVideo(videoUrl, { autoFill = true } = {}) {
		const isObjectVideo = (v) => v && typeof v === 'object' && v.url;

		const isValidPrimitive =
			typeof videoUrl === 'string' ||
			Buffer.isBuffer(videoUrl) ||
			isObjectVideo(videoUrl) ||
			(Array.isArray(videoUrl) && videoUrl.every((v) => typeof v === 'string' || Buffer.isBuffer(v) || isObjectVideo(v)));

		if (!isValidPrimitive) {
			throw new TypeError('videoUrl must be string | buffer | object | array');
		}

		const items = Array.isArray(videoUrl) ? videoUrl : [videoUrl];

		this._submessages.push({
			messageType: 2,
			messageText: '[ CANNOT_LOAD_VIDEO - \u004E\u0049\u0058\u0045\u004C ]',
		});

		items.forEach((item) => {
			const isObject = isObjectVideo(item);

			const url = isObject ? Toolkit.resolveMedia(this.#client, item.url ?? '', 'video') : Toolkit.resolveMedia(this.#client, item, 'video');

			const bufferPromise = autoFill ? Promise.resolve(url).then((u) => Toolkit.fetchBuffer(u)) : null;

			const file_length = isObject && item.file_length != null ? item.file_length : autoFill ? bufferPromise.then((b) => b?.length ?? 0) : 0;

			const duration =
				isObject && item.duration != null
					? item.duration
					: autoFill
						? bufferPromise.then((b) =>
								Toolkit.getMp4Duration(b, {
									silent: true,
								})
							)
						: 0;

			const thumbnail =
				isObject && item.thumbnail
					? Toolkit.resolveMedia(this.#client, item.thumbnail, 'image', {
							result: 'base64',
							resize: true,
							width: 300,
							height: 300,
						})
					: autoFill
						? bufferPromise
							? bufferPromise.then((b) =>
									Toolkit.getMp4Preview(b, {
										time: 0,
										result: 'base64',
									})
								)
							: null
						: null;

			this._sections.push(
				AIRich.newLayout('Single', {
					media: {
						url,
						mime_type: isObject ? (item.mime_type ?? 'video/mp4') : 'video/mp4',
						file_length,
						duration,
					},
					imagine_type: 'ANIMATE',
					status: { status: 'READY' },
					thumbnail: {
						raw_media: thumbnail,
					},
					__typename: 'GenAIImaginePrimitive',
				})
			);
		});

		return this;
	}

	addProduct(data = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Product items must be an object or an array of objects');
		}

		this._submessages.push({
			messageType: 2,
			messageText: '[ CANNOT_LOAD_PRODUCT - NIXEL ]',
		});

		const items = Array.isArray(data) ? data : [data];

		const product = items.map((item) => ({
			title: item.title,
			brand: item.brand,
			price: item.price,
			sale_price: item.sale_price,
			product_url: item.product_url ?? item.url,
			image: {
				url: Toolkit.resolveMedia(this.#client, item.image_url ?? item.image, 'image'),
			},
			additional_images: [
				{
					url: Toolkit.resolveMedia(this.#client, item.icon_url ?? item.icon, 'image'),
				},
			],
			__typename: 'GenAIProductItemCardPrimitive',
		}));

		this._sections.push(AIRich.newLayout(Array.isArray(data) ? 'HScroll' : 'Single', Array.isArray(data) ? product : product[0]));

		return this;
	}

	addPost(data = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Post items must be an object or an array of objects');
		}

		const posts = Array.isArray(data) ? data : [data];

		this._submessages.push({
			messageType: 2,
			messageText: '[ CANNOT_LOAD_POST - NIXEL ]',
		});

		const primitives = posts.map((p) => ({
			title: p.title ?? '',
			subtitle: p.subtitle ?? '',
			username: p.username ?? '',
			profile_picture_url: Toolkit.resolveMedia(this.#client, p.profile_picture_url ?? p.profile_url ?? p.profile ?? '', 'image'),
			is_verified: !!(p.is_verified || p.verified),
			thumbnail_url: Toolkit.resolveMedia(this.#client, p.thumbnail_url ?? p.thumbnail ?? '', 'image'),
			post_caption: p.post_caption ?? p.caption ?? '',
			likes_count: p.likes_count ?? p.like ?? 0,
			comments_count: p.comments_count ?? p.comment ?? 0,
			shares_count: p.shares_count ?? p.share ?? 0,
			post_url: p.post_url ?? p.url ?? '',
			post_deeplink: p.post_deeplink ?? p.deeplink ?? '',
			source_app: p.source_app || p.source || 'INSTAGRAM',
			footer_label: p.footer_label ?? p.footer ?? '',
			footer_icon: Toolkit.resolveMedia(this.#client, p.footer_icon ?? p.icon ?? '', 'image'),
			is_carousel: posts.length > 1,
			orientation: p.orientation ?? 'LANDSCAPE',
			post_type: p.post_type ?? 'VIDEO',
			__typename: 'GenAIPostPrimitive',
		}));

		this._sections.push(AIRich.newLayout('HScroll', primitives));

		return this;
	}

	addTip(text) {
		this._submessages.push({
			messageType: 2,
			messageText: text,
		});

		this._sections.push(
			AIRich.newLayout('Single', {
				text,
				__typename: 'GenAIMetadataTextPrimitive',
			})
		);

		return this;
	}

	addSuggest(suggestion, { scroll = true, layout } = {}) {
		if (!(typeof suggestion === 'string' || (Array.isArray(suggestion) && suggestion.every((v) => typeof v === 'string')))) {
			throw new TypeError('Suggestion must be a string or array of strings');
		}

		const suggest = Array.isArray(suggestion)
			? suggestion.map((text) => ({
					prompt_text: text,
					prompt_type: 'SUGGESTED_PROMPT',
					__typename: 'GenAIFollowUpSuggestionPillPrimitive',
				}))
			: [
					{
						prompt_text: suggestion,
						prompt_type: 'SUGGESTED_PROMPT',
						__typename: 'GenAIFollowUpSuggestionPillPrimitive',
					},
				];

		const type = layout ?? (suggest.length === 1 ? 'Single' : scroll ? 'HScroll' : 'ActionRow');

		this._sections.push(AIRich.newLayout(type, type === 'Single' ? suggest[0] : suggest, { __typename: 'GenAIUnifiedResponseSection' }));

		return this;
	}

	async build({ forwarded = true, notification = false, includesUnifiedResponse = true, includesSubmessages = true, quoted, quotedParticipant, ...options } = {}) {
		const forward = forwarded
			? {
					forwardingScore: 1,
					isForwarded: true,
					forwardedAiBotMessageInfo: { botJid: '0@bot' },
					forwardOrigin: 4,
				}
			: {};

		const notif = notification
			? {
					sessionTransparencyMetadata: {
						disclaimerText: '~ Ahmad tumbuh kembang',
						hcaId: `hca_${Date.now()}`,
						sessionTransparencyType: 1,
					},
				}
			: {};

		const qObj = quoted
			? {
					stanzaId: quoted?.key?.id || quoted?.id,
					participant: quotedParticipant || quoted?.key?.participant || quoted?.key?.remoteJid,
					quotedType: 0,
					quotedMessage: typeof quoted === 'object' && quoted !== null ? (quoted.message ?? quoted) : undefined,
				}
			: {};

		const sections = this._footer
			? [
					...(await waitAllPromises(this._sections)),
					AIRich.newLayout('Single', {
						text: this._footer,
						__typename: 'GenAIMetadataTextPrimitive',
					}),
				]
			: [...(await waitAllPromises(this._sections))];

		return {
			messageContextInfo: {
				deviceListMetadata: {},
				deviceListMetadataVersion: 2,
				botMetadata: {
					messageDisclaimerText: this._title,
					richResponseSourcesMetadata: { sources: this._richResponseSources },
					...notif,
				},
			},
			...this._extraPayload,
			botForwardedMessage: {
				message: {
					richResponseMessage: {
						messageType: 1,
						submessages: includesSubmessages ? await waitAllPromises(this._submessages) : [],
						unifiedResponse: {
							data: includesUnifiedResponse ? Buffer.from(JSON.stringify({ response_id: crypto.randomUUID(), sections })).toString('base64') : '',
						},
						contextInfo: {
							...forward,
							...qObj,
							...this._contextInfo,
						},
					},
				},
			},
		};
	}

	async send(jid, { forwarded, notification, includesUnifiedResponse, includesSubmessages, ...options } = {}) {
		const msg = await this.build({ forwarded, notification, includesUnifiedResponse, includesSubmessages, ...options });

		return await this.#client.relayMessage(jid, msg, { ...options });
	}

	static tokenizer(code, lang = 'javascript') {
		const keywordsMap = {
			javascript: new Set([
				'break', 'case', 'catch', 'continue', 'debugger', 'delete', 'do', 'else', 'finally', 'for',
				'function', 'if', 'in', 'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'typeof',
				'var', 'void', 'while', 'with', 'true', 'false', 'null', 'undefined', 'class', 'const', 'let',
				'super', 'extends', 'export', 'import', 'yield', 'static', 'constructor', 'async', 'await',
				'get', 'set',
			]),

			typescript: new Set([
				'abstract', 'any', 'as', 'asserts', 'bigint', 'boolean', 'declare', 'enum', 'implements',
				'infer', 'interface', 'is', 'keyof', 'module', 'namespace', 'never', 'readonly', 'require',
				'number', 'object', 'override', 'private', 'protected', 'public', 'satisfies', 'string',
				'symbol', 'type', 'unknown', 'using', 'from', 'break', 'case', 'catch', 'continue', 'do',
				'else', 'finally', 'for', 'function', 'if', 'new', 'return', 'switch', 'this', 'throw', 'try',
				'var', 'void', 'while', 'class', 'const', 'let', 'extends', 'import', 'export', 'async',
				'await',
			]),

			python: new Set([
				'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
				'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import',
				'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
				'with', 'yield',
			]),

			java: new Set([
				'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
				'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
				'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long',
				'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static',
				'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try',
				'void', 'volatile', 'while',
			]),

			golang: new Set([
				'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
				'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return',
				'select', 'struct', 'switch', 'type', 'var',
			]),

			c: new Set([
				'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else',
				'enum', 'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short',
				'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
				'volatile', 'while',
			]),

			cpp: new Set([
				'alignas', 'alignof', 'and', 'auto', 'bool', 'break', 'case', 'catch', 'class', 'const',
				'constexpr', 'continue', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'export',
				'extern', 'false', 'float', 'for', 'friend', 'if', 'inline', 'int', 'long', 'mutable',
				'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private', 'protected', 'public',
				'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this',
				'throw', 'true', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void',
				'while',
			]),

			php: new Set([
				'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone',
				'const', 'continue', 'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty',
				'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'extends', 'final',
				'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if', 'implements', 'include',
				'include_once', 'instanceof', 'interface', 'match', 'namespace', 'new', 'null', 'or',
				'private', 'protected', 'public', 'require', 'require_once', 'return', 'static', 'switch',
				'throw', 'trait', 'try', 'use', 'var', 'while', 'yield',
			]),

			rust: new Set([
				'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for',
				'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
				'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where',
				'while',
			]),

			html: new Set([
				'html', 'head', 'body', 'div', 'span', 'p', 'a', 'img', 'video', 'audio', 'script', 'style',
				'link', 'meta', 'form', 'input', 'button', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li',
				'section', 'article', 'header', 'footer', 'nav', 'main',
			]),

			bash: new Set([
				'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function',
				'in', 'select', 'until', 'break', 'continue', 'return', 'export', 'readonly', 'local',
				'declare',
			]),

			markdown: new Set(['#', '##', '###', '####', '#####', '######']),
		};

		if (!lang || lang === 'txt' || lang === 'text' || lang === 'plaintext') {
			return {
				codeBlock: [
					{
						codeContent: code,
						highlightType: 0,
					},
				],
				unified_codeBlock: [
					{
						content: code,
						type: 'DEFAULT',
					},
				],
			};
		}

		const TYPE_MAP = {
			0: 'DEFAULT',
			1: 'KEYWORD',
			2: 'METHOD',
			3: 'STR',
			4: 'NUMBER',
			5: 'COMMENT',
		};

		const keywords = keywordsMap[lang.toLowerCase()] || new Set();
		const tokens = [];

		let i = 0;

		const push = (content, type) => {
			if (!content) return;

			const last = tokens[tokens.length - 1];

			if (last && last.highlightType === type) {
				last.codeContent += content;
			} else {
				tokens.push({
					codeContent: content,
					highlightType: type,
				});
			}
		};

		const isIdentifier = (char) => {
			switch (lang.toLowerCase()) {
				case 'css':
					return /[a-zA-Z0-9_$-]/.test(char);

				case 'html':
					return /[a-zA-Z0-9_$:-]/.test(char);

				default:
					return /[a-zA-Z0-9_$]/.test(char);
			}
		};

		while (i < code.length) {
			const c = code[i];

			if (/\s/.test(c)) {
				let s = i;

				while (i < code.length && /\s/.test(code[i])) {
					i++;
				}

				push(code.slice(s, i), 0);
				continue;
			}

			if ((c === '/' && code[i + 1] === '/') || (c === '#' && ['python', 'bash'].includes(lang))) {
				let s = i;

				while (i < code.length && code[i] !== '\n') {
					i++;
				}

				push(code.slice(s, i), 5);
				continue;
			}

			if (c === '"' || c === "'" || c === '`') {
				let s = i;
				const q = c;

				i++;

				while (i < code.length) {
					if (code[i] === '\\' && i + 1 < code.length) {
						i += 2;
					} else if (code[i] === q) {
						i++;
						break;
					} else {
						i++;
					}
				}

				push(code.slice(s, i), 3);
				continue;
			}

			if (/[0-9]/.test(c)) {
				let s = i;

				while (i < code.length && /[0-9._]/.test(code[i])) {
					i++;
				}

				push(code.slice(s, i), 4);
				continue;
			}

			if (/[a-zA-Z_$]/.test(c)) {
				let s = i;

				while (i < code.length && isIdentifier(code[i])) {
					i++;
				}

				const word = code.slice(s, i);

				let type = 0;

				if (keywords.has(word)) {
					type = 1;
				} else if (lang === 'css') {
					let j = i;

					while (j < code.length && /\s/.test(code[j])) {
						j++;
					}

					if (code[j] === ':') {
						type = 1;
					}
				} else if (lang === 'html') {
					let p = s - 1;

					while (p >= 0 && /\s/.test(code[p])) {
						p--;
					}

					if (code[p] === '<' || (code[p] === '/' && code[p - 1] === '<')) {
						type = 1;
					}
				}

				if (type === 0) {
					let j = i;

					while (j < code.length && /\s/.test(code[j])) {
						j++;
					}

					if (code[j] === '(') {
						type = 2;
					}
				}

				push(word, type);
				continue;
			}

			push(c, 0);
			i++;
		}

		return {
			codeBlock: tokens,
			unified_codeBlock: tokens.map((t) => ({
				content: t.codeContent,
				type: TYPE_MAP[t.highlightType],
			})),
		};
	}

	static toTableMetadata(arr, { hyperlink = true, citation = true, latex = true } = {}) {
		if (!Array.isArray(arr) || !arr.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'))) {
			throw new TypeError('Table must be a nested array of strings');
		}

		const [header, ...rows] = arr;

		const maxLen = Math.max(header.length, ...rows.map((r) => r.length));

		const normalize = (r) => [...r, ...Array(maxLen - r.length).fill('')];

		const unified_rows = [
			{
				is_header: true,
				cells: normalize(header),
			},
			...rows.map((r) => ({
				is_header: false,
				cells: normalize(r),
			})),
		].map((row) => {
			const markdown_cells = row.cells.map((cell) => {
				const extracted = extractIE(cell, { hyperlink, citation, latex });

				return {
					text: extracted.text,
					...(extracted.inline_entities.length ? { inline_entities: extracted.inline_entities } : {}),
				};
			});

			return {
				...row,
				...(markdown_cells.some((c) => c.inline_entities?.length) ? { markdown_cells } : {}),
			};
		});

		const rowsMeta = unified_rows.map((r) => ({
			items: r.cells,
			...(r.is_header ? { isHeading: true } : {}),
		}));

		return {
			title: '',
			rows: rowsMeta,
			unified_rows,
		};
	}

	static newLayout(name, data, extra = {}) {
		return {
			...extra,
			view_model: {
				[Array.isArray(data) ? 'primitives' : 'primitive']: data,
				__typename: `GenAI${name}LayoutViewModel`,
			},
		};
	}
}

// ================================



export function HelperConnection(conn, { store, logger }) {
    const botUser = conn.user || {}

    // ================= Native Flow / Carousel helpers (native-flow style) =================

function nfNormalizeRow(row = {}) {
    return {
        header: String(row.header || ''),
        title: String(row.title || row.id || ''),
        description: String(row.description || ''),
        id: String(row.id || row.rowId || row.title || '')
    }
}

function nfNormalizeSections(sections = []) {
    return (sections || []).map(section => ({
        title: String(section.title || ''),
        ...(section.highlight_label ? { highlight_label: String(section.highlight_label) } : {}),
        rows: (section.rows || []).map(nfNormalizeRow)
    }))
}

function nfBuildPaymentButton(item = {}) {
    const p = item.payment || {}
    const amount = {
        value: Number(p.value ?? p.amount ?? 0),
        offset: Number(p.offset ?? 100)
    }
    const itemName = String(p.itemName || p.item_name || item.text || 'Pembayaran')
    const order = p.order || {
        status: 'pending',
        subtotal: amount,
        order_type: 'ORDER',
        items: [{
            name: itemName,
            amount,
            quantity: Number(p.quantity || 1),
            sale_amount: amount
        }]
    }
    const paymentSettings = p.paymentSettings || p.payment_settings || [{
        type: 'payment_key',
        payment_key: {
            type: String(p.accountType || p.institutionType || 'IDPAYMENTACCOUNT'),
            key: String(p.accountKey || p.key || ''),
            name: String(p.accountName || p.name || ''),
            institution_name: String(p.institution || p.institution_name || ''),
            full_name_on_account: String(p.fullName || p.full_name_on_account || '')
        }
    }]
    return {
        name: 'payment_key_info',
        buttonParamsJson: JSON.stringify({
            currency: String(p.currency || 'IDR'),
            total_amount: amount,
            reference_id: String(p.referenceId || p.reference_id || `INV-${Date.now()}`),
            type: String(p.type || 'physical-goods'),
            order,
            payment_settings: paymentSettings,
            share_payment_status: !!p.sharePaymentStatus,
            is_soft_deleted: false,
            referral: String(p.referral || 'chat_attachment')
        })
    }
}

function nfBuildButton(item = {}) {
    if (item.payment) {
        return nfBuildPaymentButton(item)
    }
    if (item.sections) {
        return {
            name: 'single_select',
            buttonParamsJson: JSON.stringify({
                title: String(item.text || ''),
                sections: nfNormalizeSections(item.sections)
            })
        }
    }
    if (item.call) {
        return {
            name: 'cta_call',
            buttonParamsJson: JSON.stringify({
                display_text: String(item.text || ''),
                phone_number: String(item.call)
            })
        }
    }
    if (item.copy) {
        return {
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({
                display_text: String(item.text || ''),
                copy_code: String(item.copy)
            })
        }
    }
    if (item.url) {
        return {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text: String(item.text || ''),
                url: String(item.url),
                merchant_url: String(item.url),
                webview_interaction: !!item.useWebview
            })
        }
    }
    return {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
            display_text: String(item.text || ''),
            id: String(item.id || item.text || '')
        })
    }
}

function nfBuildButtons(nativeFlow = [], { optionText, optionTitle } = {}) {
    const list = (Array.isArray(nativeFlow) ? nativeFlow : [nativeFlow])
        .filter(item => item && typeof item === 'object' && (item.text || item.id || item.call || item.copy || item.url || item.sections || item.payment))
    
    if (!list.length) return []

    const built = list.map(nfBuildButton)

    // Mode dengan optionTitle & optionText: bottom_sheet aktif lewat messageParamsJson,
    // jadi TIDAK perlu leading empty object `{}` sebagai separator manual — posisi
    // divider-nya sudah diatur lewat `divider_indices` di messageParamsJson.
    // Button-button tetap dikirim apa adanya sesuai tipenya masing-masing
    // (quick_reply tetap quick_reply, single_select tetap single_select, dst),
    // TIDAK digabung jadi satu list — persis seperti payload native WhatsApp:
    //   buttons: [ {name:'quick_reply', ...}, {name:'single_select', ...} ]
    if (optionTitle && optionText) {
        return built
    }
    
    // Mode normal (tanpa optionTitle & optionText): Kirim semua button terpisah dengan leading empty object
    return [{}, ...built]
}

function nfBuildMessageParams(buttons = [], { optionText, optionTitle, ltoText, ltoUrl, ltoCode, ltoExpiration } = {}) {
    const params = {}
    
    // Jika ada optionTitle/optionText, selalu buat bottom_sheet
    if (optionTitle || optionText) {
        // optionText -> list_title (judul list saat bottom sheet terbuka)
        // optionTitle -> button_title (label tombol pemicu bottom sheet)
        const listTitle = String(optionText || optionTitle || 'Select')
        const buttonTitle = String(optionTitle || optionText || 'Select')
        
        // divider_indices menandai posisi SETIAP button yang butuh garis pemisah
        // sebelumnya, persis seperti raw payload WhatsApp:
        //   buttons: [quick_reply, single_select] -> divider_indices: [0, 1]
        const namedIndices = (buttons || [])
            .map((b, i) => (b && b.name) ? i : -1)
            .filter(i => i >= 0)
        const dividerIndices = namedIndices.length ? namedIndices : [0]
        
        params.bottom_sheet = {
            in_thread_buttons_limit: 1,
            divider_indices: dividerIndices,
            list_title: listTitle,
            button_title: buttonTitle
        }
    }
    
    // limited_time_offer -> banner countdown/promo di dalam interactive message.
    // Param INDEPENDEN dari offerText/offerCode/offerUrl/offerExpiration (yang itu
    // punya contextInfo.externalAdReply), supaya bisa dites/dipakai terpisah tanpa
    // saling mempengaruhi.
    if (ltoText || ltoUrl || ltoCode) {
        params.limited_time_offer = {
            text: String(ltoText || ''),
            ...(ltoUrl ? { url: String(ltoUrl) } : {}),
            ...(ltoCode ? { copy_code: String(ltoCode) } : {}),
            ...(ltoExpiration ? { expiration_time: Number(ltoExpiration) } : {})
        }
    }
    
    return Object.keys(params).length ? JSON.stringify(params) : undefined
}

// WhatsApp expects the `native_flow` additionalNode's `name` attr to match
// the single button type when only one type is present (e.g. 'payment_key_info',
// 'single_select'), and falls back to 'mixed' + v:'9' when button types are combined.
function nfNativeFlowAttrs(buttons = []) {
    const names = [...new Set((buttons || []).filter(b => b && b.name).map(b => b.name))]
    return names.length === 1 ? { name: names[0] } : { name: 'mixed', v: '9' }
}

function nfBuildOffer({ offerText, offerCode, offerUrl, offerExpiration } = {}) {
    if (!offerText && !offerCode && !offerUrl) return null
    return {
        text: String(offerText || ''),
        ...(offerCode ? { code: String(offerCode) } : {}),
        ...(offerUrl ? { url: String(offerUrl) } : {}),
        ...(offerExpiration ? { expiration: Number(offerExpiration) } : {})
    }
}

async function nfBuildHeader({ image, video, document, title = '', subtitle = '', mimetype, fileName, fileLength, jpegThumbnail } = {}) {
    const readSource = async (source) => {
        if (Buffer.isBuffer(source)) return source
        if (source && typeof source === 'object' && source.url) source = source.url
        if (typeof source === 'string') {
            if (/^https?:\/\//i.test(source)) return Buffer.from(await (await fetch(source)).arrayBuffer())
            return fs.readFileSync(source)
        }
        return null
    }
    const resolveThumb = async (thumb) => {
        if (!thumb) return null
        if (Buffer.isBuffer(thumb)) return thumb.toString('base64')
        if (typeof thumb === 'string') return thumb // assume already base64
        return null
    }
    if (image) {
        const buf = await readSource(image)
        const media = await prepareWAMessageMedia({ image: buf }, { upload: conn.waUploadToServer })
        if (mimetype && media.imageMessage) media.imageMessage.mimetype = mimetype
        return { title, subtitle, hasMediaAttachment: true, ...media }
    }
    if (video) {
        const buf = await readSource(video)
        const media = await prepareWAMessageMedia({ video: buf }, { upload: conn.waUploadToServer })
        if (mimetype && media.videoMessage) media.videoMessage.mimetype = mimetype
        return { title, subtitle, hasMediaAttachment: true, ...media }
    }
    if (document) {
        const source = typeof document === 'object' && !Buffer.isBuffer(document) ? document : { url: document }
        const buf = await readSource(source)
        const media = await prepareWAMessageMedia({
            document: buf,
            mimetype: mimetype || source.mimetype || 'application/octet-stream',
            fileName: fileName || source.fileName || source.filename || 'file'
        }, { upload: conn.waUploadToServer })
        const thumb = await resolveThumb(jpegThumbnail || source.jpegThumbnail || source.thumbnail)
        if (media.documentMessage) {
            if (thumb) media.documentMessage.jpegThumbnail = thumb
            if (fileLength) media.documentMessage.fileLength = String(fileLength)
            if (fileName) media.documentMessage.fileName = fileName
            if (mimetype) media.documentMessage.mimetype = mimetype
        }
        return { title, subtitle, hasMediaAttachment: true, ...media }
    }
    return { title, subtitle, hasMediaAttachment: false }
}

async function nfBuildInteractive(opts = {}) {
    const {
        image, video, document,
        caption = '', text = '', body = '',
        footer = '',
        optionText, optionTitle,
        offerText, offerCode, offerUrl, offerExpiration,
        ltoText, ltoUrl, ltoCode, ltoExpiration,
        mimetype, fileName, fileLength, jpegThumbnail,
        mentions,
        nativeFlow = []
    } = opts

    const header = await nfBuildHeader({ image, video, document, mimetype, fileName, fileLength, jpegThumbnail })
    const buttons = nfBuildButtons(nativeFlow, { optionText, optionTitle })
    const messageParamsJson = nfBuildMessageParams(buttons, { optionText, optionTitle, ltoText, ltoUrl, ltoCode, ltoExpiration })
    const offer = nfBuildOffer({ offerText, offerCode, offerUrl, offerExpiration })

    return {
        header,
        body: { text: String(caption || text || body || '') },
        footer: { text: String(footer || '') },
        nativeFlowMessage: { 
            buttons, 
            ...(messageParamsJson ? { messageParamsJson } : {}) 
        },
        ...(mentions ? { contextInfo: { mentionedJid: mentions } } : {}),
        ...(offer ? { 
            contextInfo: { 
                ...(mentions ? { mentionedJid: mentions } : {}), 
                externalAdReply: { 
                    title: offer.text, 
                    body: offer.code || '', 
                    thumbnailUrl: offer.url, 
                    mediaType: 1, 
                    renderLargerThumbnail: false 
                } 
            } 
        } : {}),
    }
}

function isNativeFlowStyle(opts = {}) {
    return !!(opts.nativeFlow || opts.cards || opts.image || opts.video || opts.document || opts.caption || (opts.text && !opts.body && !opts.buttons))
}

    /** @type {import('baileys').WASocket} */
    let sock = Object.defineProperties(conn, {
        decodeJid: {
            value(jid) {
                if (!jid || typeof jid !== 'string') return (!nullish(jid) && jid) || null
                jid = jid.trim()
                // @lid format tidak bisa di-decode dengan jidDecode biasa, kembalikan as-is
                if (jid.endsWith('@lid')) return jid
                try {
                    const decoded = jidDecode(jid)
                    if (decoded?.user && decoded?.server) {
                        jid = `${decoded.user}@${decoded.server}`
                    }
                } catch {}
                try {
                    jid = jidNormalizedUser(jid) || jid
                } catch {}
                return jid
            }
        },
        logger: {
            value: {
                ...logger,
                info: logger.info?.bind(logger),
                error: logger.error?.bind(logger),
                warn: logger.warn?.bind(logger),
                fatal: logger.fatal?.bind(logger),
                debug: logger.debug?.bind(logger),
                trace: logger.trace?.bind(logger)
            },
            enumerable: true,
            writable: true
        },
        getFile: {
            /**
             * getBuffer hehe
             * @param {fs.PathLike} PATH 
             * @param {Boolean} saveToFile
             * @returns {Promise<{
             *  res: Response
             *  filename?: string
             *  data: Readable
             *  toBuffer: () => Promise<Buffer>
             *  clear: () => Promise<void>
             * }>}
             */
            async value(PATH, saveToFile = false) {
                let res,
                    filename,
                    /** @type {Readable | Buffer} */
                    data
                if (Buffer.isBuffer(PATH) || Helper.isReadableStream(PATH)) data = PATH
                // Convert ArrayBuffer to buffer using prototype function
                else if (PATH instanceof ArrayBuffer) data = PATH.toBuffer()
                else if (/^data:.*?\/.*?;base64,/i.test(PATH)) data = Buffer.from(PATH.split`,`[1], 'base64')
                else if (/^https?:\/\//.test(PATH)) {
                    res = await fetch(PATH)
                    data = res.body
                } else if (fs.existsSync(PATH)) {
                    filename = PATH
                    data = fs.createReadStream(PATH)
                } else data = Buffer.alloc(0)
                let isStream = Helper.isReadableStream(data)
                if (!isStream || Buffer.isBuffer(data)) {
                    if (!Buffer.isBuffer(data)) throw new TypeError('Converting buffer to stream, but data have type' + typeof data, data)
                    data = toReadable(data)
                    isStream = true
                }
                const streamWithType = await fileTypeStream(data) ||
                    { ...data, mime: 'application/octet-stream', ext: '.bin' }
                if (data && saveToFile && !filename) {
                    filename = path.join(`${process.cwd() + "/" + process.env.TMP}/${Date.now()}.${streamWithType.fileType.ext}`)
                    await Helper.saveStreamToFile(data, filename)
                }
                return {
                    res,
                    filename,
                    ...streamWithType.fileType,
                    data: streamWithType,
                    async toBuffer() {
                        const buffers = []
                        for await (const chunk of streamWithType) buffers.push(chunk)
                        return Buffer.concat(buffers)
                    },
                    async clear() {
                        // if (res) /** @type {Response} */ (res).body
                        streamWithType.destroy()
                        if (filename) await fs.promises.unlink(filename)
                    }
                }
            },
            enumerable: true,
            writable: true,
        },
        // waitEvent: {
        //     /**
        //      * waitEvent
        //      * @param {String} eventName 
        //      * @param {Boolean} is 
        //      * @param {Number} maxTries 
        //      */
        //     value(eventName, is = () => true, maxTries = 25) { //Idk why this exist?
        //         return new Promise((resolve, reject) => {
        //             let tries = 0
        //             let on = (...args) => {
        //                 if (++tries > maxTries) reject('Max tries reached')
        //                 else if (is()) {
        //                     conn.ev.off(eventName, on)
        //                     resolve(...args)
        //                 }
        //             }
        //             conn.ev.on(eventName, on)
        //         })
        //     }
        // },
        sendFile: {
            /**
             * Send Media/File with Automatic Type Specifier
             * @param {String} jid
             * @param {String|Buffer} path
             * @param {String} filename
             * @param {String} caption
             * @param {import('baileys').proto.WebMessageInfo} quoted
             * @param {Boolean} ptt
             * @param {Object} options
             */
            async value(jid, path, filename = '', caption = '', quoted, ptt = false, options = {}) {
                const file = await conn.getFile(path)
                let mtype = '',
                    stream = file.data,
                    mimetype = options.mimetype || file.mime,
                    toBuffer = file.toBuffer,
                    convert
                const opt = {}
                if (quoted) opt.quoted = quoted
                if (!file.ext === '.bin') options.asDocument = true
                if (/webp/.test(file.mime) || (/image/.test(file.mime) && options.asSticker)) mtype = 'sticker'
                else if (/image/.test(file.mime) || (/webp/.test(file.mime) && options.asImage)) mtype = 'image'
                else if (/video/.test(file.mime)) mtype = 'video'
                else if (/audio/.test(file.mime)) (
                    convert = await toAudio(stream, file.ext),
                    stream = convert.data,
                    toBuffer = convert.toBuffer,
                    mtype = 'audio',
                    mimetype = options.mimetype || 'audio/ogg; codecs=opus'
                )
                else mtype = 'document'
                if (options.asDocument) mtype = 'document'
                delete options.asSticker
                delete options.asLocation
                delete options.asVideo
                delete options.asDocument
                delete options.asImage
                let message = {
                    ...options,
                    caption,
                    ptt,
                    [mtype]: { stream },
                    mimetype,
                    fileName: filename || ''
                }
                let error = false
                try {
                    return await conn.sendMessage(jid, message, { ...opt, ...options })
                } catch (e) {
                    console.error(e)
                    return await conn.sendMessage(jid, { ...message, [mtype]: await toBuffer() }, { ...opt, ...options })
                        .catch(e => (error = e))
                } finally {
                    file.clear()
                    if (convert) convert.clear()
                    if (error) throw error
                }
            },
            enumerable: true,
            writable: true,
        },
        resize: {
        	value(buffer, width, height) {
        	return new Promise(async(resolve, reject) => {
        var buff = await Jimp.read(buffer)
        var a = await buff.resize({w: width,h: height})
        var ab = await a.getBuffer('image/png')
        resolve(ab)
       })
      }
    },
        crop: {
        	value(buffer, ukur1, ukur2, ukur3, ukur4) {
        	return new Promise(async (resolve, reject) => {
     var abc = await Jimp.read(buffer)
     var a = abc.crop(ukur1, ukur2, ukur3, ukur4).getBufferAsync(Jimp.MIME_JPEG) 
     resolve(a)
  })
  }},
        sendContact: {            /**
             * Send Contact
             * @param {String} jid 
             * @param {String[][]|String[]} data
             * @param {import('baileys').proto.WebMessageInfo} quoted 
             * @param {Object} options 
             */
            async value(jid, data, quoted, options) {
                if (!Array.isArray(data[0]) && typeof data[0] === 'string') data = [data]
                let contacts = []
                for (let [number, name] of data) {
                    number = number.replace(/[^0-9]/g, '')
                    let njid = number + '@s.whatsapp.net'
                    let biz = await conn.getBusinessProfile(njid) || {}
                    let vcard = `
BEGIN:VCARD
VERSION:3.0
N:;${name.replace(/\n/g, '\\n')};;;
FN:${name.replace(/\n/g, '\\n')}
ORG:
item1.TEL;waid=${number}:${PhoneNumber('+' + number).getNumber('international')}
item1.X-ABLabel:Ponsel${biz.description ? `
item2.EMAIL;type=INTERNET:${(biz.email || '').replace(/\n/g, '\\n')}
item2.X-ABLabel:Email
PHOTO;BASE64:${(await conn.getFile(await conn.profilePictureUrl(njid)).catch(_ => ({})) || {}).number?.toString('base64')}
X-WA-BIZ-NAME:${(Connection.store.getContact(njid)?.vname || conn.getName(njid) || name).replace(/\n/, '\\n')}
X-WA-BIZ-DESCRIPTION:${biz.description.replace(/\n/g, '\\n')}
` : ''}
END:VCARD
        `.trim()
                    contacts.push({ vcard, displayName: name })
                }
                return await conn.sendMessage(jid, {
                    ...options,
                    contacts: {
                        ...options,
                        displayName: (contacts.length >= 2 ? `${contacts.length} kontak` : contacts[0].displayName) || null,
                        contacts,
                    }
                }, { quoted, ...options })
            },
            enumerable: true,
            writable: true,
        },
        sendArrayContact: { async value(jid, data, quoted, options) {
        let contacts = []
        for (let [number, nama, ponsel, email] of data) {
            number = number.replace(/[^0-9]/g, '')
            let njid = number + '@s.whatsapp.net'
            let name = db.data.users[njid] ? db.data.users[njid].name : conn.getName(njid)
            let biz = await conn.getBusinessProfile(njid) || {}
            // N:;${name.replace(/\n/g, '\\n').split(' ').reverse().join(';')};;;
            let vcard = `
BEGIN:VCARD
VERSION:3.0
FN:${name.replace(/\n/g, '\\n')}
ORG:
item1.TEL;waid=${number}:${PhoneNumber('+' + number).getNumber('international')}
item1.X-ABLabel:📌 ${ponsel}
item2.EMAIL;type=INTERNET:${email}
item2.X-ABLabel:✉️ Email
X-WA-BIZ-DESCRIPTION:${(biz.description || '').replace(/\n/g, '\\n')}
X-WA-BIZ-NAME:${name.replace(/\n/g, '\\n')}
END:VCARD
`.trim()
            contacts.push({ vcard, displayName: name })
        }
        return await conn.sendMessage(jid, {
            contacts: {
                 ...options,
                displayName: (contacts.length > 1 ? `${contacts.length} kontak` : contacts[0].displayName) || null,
                contacts,
            },
        }, { quoted, ...options, ephemeralExpiration: global.ephemeral })
    }
    },
        reply: {
            /**
             * Reply to a message
             * @param {String} jid
             * @param {String|Buffer} text
             * @param {import('baileys').proto.WebMessageInfo} quoted
             * @param {Object} options
             */
            value(jid, text = '', quoted, options) {
                return Buffer.isBuffer(text) ? conn.sendFile(jid, text, 'file', '', quoted, false, options) : conn.sendMessage(jid, { ...options, text, mentions: conn.parseMention(text) }, { quoted, ...options })
            },
            writable: true,
        },
        react: {
        	value(jid, text = '', key) {
        	
        conn.sendMessage(jid, {
    	react: {
    		text: text,
    		key: key
    	}
    })	
    }},
        sendLocUrl: {
            /**
             * Kirim pesan lokasi interaktif menggunakan interactiveMessage
             * @param {string} jid - ID tujuan (user/group)
             * @param {Buffer|string|null} buffer - Thumbnail gambar (Buffer atau URL string)
             * @param {string} [title=''] - Nama lokasi
             * @param {string} [address=''] - Alamat lokasi
             * @param {string} [text=''] - Isi/konten utama pesan (body)
             * @param {string} [footer=''] - Teks footer
             * @param {string} [url=''] - URL lokasi (opsional)
             * @param {Object} [quoted] - Pesan yang di-reply/quote
             * @param {Object} [options] - Opsi tambahan
             */
            async value(jid, buffer, title = '', address = '', text = '', footer = '', url = '', quoted, options) {
                let jpegThumbnail = null
                if (buffer) {
                    const raw = typeof buffer === 'string'
                        ? Buffer.from(await fetch(buffer).then(r => r.arrayBuffer()))
                        : buffer
                    jpegThumbnail = (await conn.resize(raw, 300, 300)).toString('base64')
                }

                const additionalNodes = [{
                    tag: 'biz',
                    attrs: {},
                    content: [{
                        tag: 'interactive',
                        attrs: { type: 'native_flow', v: '1' },
                        content: [{ tag: 'native_flow', attrs: { name: 'mixed', v: '9' } }]
                    }]
                }]

                return conn.relayMessage(jid, {
                    interactiveMessage: {
                        header: {
                            hasMediaAttachment: true,
                            locationMessage: {
                                degreesLatitude: 0,
                                degreesLongitude: 0,
                                name: title,
                                address,
                                url,
                                ...(jpegThumbnail && { jpegThumbnail })
                            }
                        },
                        body:   { text },
                        footer: { text: footer },
                        nativeFlowMessage: { buttons: [] }, 
                        contextInfo: {
                            mentionedJid: await conn.parseMention(text),
                            groupMentions: [],
                            statusAttributions: []
                        }
                    }
                }, { quoted, additionalNodes, ...options })
            },
            enumerable: true,
            writable: true,
        },
       sendFooter: {
       	value(jid, text, footer, options) {
           conn.relayMessage(jid, { interactiveMessage:{ 
                body : { text: text }, 
                footer : { text : footer }, 
                nativeFlowMessage : { messageParamsJson : ""}, 
                contextInfo: {
                groupMentions: [],
                    businessMessageForwardInfo: {
                    businessOwnerJid:conn.user.jid
                },
            }
        }
        }, {})
 }
},
        sendUrlPreview: {
        /**
     * Kirim pesan dengan link preview (thumbnail-link) ke WhatsApp
     *
     * @param {string} jid - ID tujuan (user/group)
     * @param {string|Buffer|Object} image - Media gambar untuk thumbnail. Bisa url (auto-fetch jadi buffer), path lokal (auto-baca jadi buffer), Buffer langsung, atau object (contoh: { url: 'https://...' })
     * @param {string} text - Isi teks pesan (bisa "url + kalimat", contoh: "https://wa.me hai"). matched-text otomatis diambil dari URL di dalam teks ini
     * @param {string} title - Judul preview
     * @param {string} description - Deskripsi preview
     * @param {string|number|boolean|Array|Object} [preview=0] - Tipe & kualitas preview. Bisa:
     *   - string → previewType, label enum WAProto (case-insensitive), mis. 'NONE' | 'IMAGE' | 'VIDEO' | 'PROFILE'
     *   - number → previewType, index enum WAProto (mis. 0 = NONE, 7 = PROFILE — diteruskan apa
     *     adanya, TIDAK dipetakan manual, karena daftar enum lengkapnya bisa bertambah)
     *   - boolean → highQuality (mis. true)
     *   - array, urutan bebas → ['IMAGE', true] atau [true, 7]
     *   - object → { type: 'PROFILE', highQuality: true } atau { type: 7, highQuality: true }
     *   - kosong/undefined/null → default previewType 0 (NONE), highQuality false
     * @param {Object} [quoted] - Pesan yang di-quote
     * @param {Object} [options={}] - Opsi tambahan (contextInfo, matchedText khusus, dll)
     *   - options.matchedText → override manual matched-text (default: URL yang otomatis terdeteksi dari `text`)
     */
        async value(jid, image, text, title, description, preview = 0, quoted, options = {}) {
            // WAProto.ExtendedTextMessage.previewType adalah enum yang di-encode
            // sebagai string (mis. 'NONE', 'IMAGE', 'VIDEO', 'PROFILE', dst) oleh
            // protobufjs, tapi Baileys/protobufjs tetap menerima index number lama
            // untuk backward-compat dan akan resolve otomatis ke label yang benar
            // saat encode — termasuk index yang tidak kita kenal di sini (mis. 7).
            // Karena daftar enum lengkapnya tidak didokumentasikan publik dan bisa
            // bertambah kapan saja, kita TIDAK memetakan angka secara manual di sini.
            // String & number sama-sama diteruskan apa adanya; hanya string yang
            // di-uppercase supaya penulisan case-insensitive ('image' == 'IMAGE').
            const normalizePreviewType = (v) => {
                if (typeof v === 'string') {
                    const upper = v.trim().toUpperCase()
                    return upper || undefined
                }
                if (typeof v === 'number' && !Number.isNaN(v)) {
                    return v
                }
                return undefined
            }

            let previewType = 0
            let highQuality = false

            if (typeof preview === 'string' || typeof preview === 'number') {
                previewType = normalizePreviewType(preview) ?? previewType
            } else if (typeof preview === 'boolean') {
                highQuality = preview
            } else if (Array.isArray(preview)) {
                for (const v of preview) {
                    if (typeof v === 'string' || typeof v === 'number') {
                        const normalized = normalizePreviewType(v)
                        if (normalized !== undefined) previewType = normalized
                    } else if (typeof v === 'boolean') {
                        highQuality = v
                    }
                }
            } else if (preview && typeof preview === 'object') {
                if (typeof preview.type === 'string' || typeof preview.type === 'number') {
                    const normalized = normalizePreviewType(preview.type)
                    if (normalized !== undefined) previewType = normalized
                }
                if (typeof preview.highQuality === 'boolean') highQuality = preview.highQuality
            }

            const urlRegex = /(https?:\/\/[^\s]+)/i
            const matchedText = options.matchedText || (text.match(urlRegex)?.[0]) || text

            let imageSource
            if (Buffer.isBuffer(image)) {
                imageSource = image
            } else if (typeof image === 'string') {
                if (/^https?:\/\//i.test(image)) {
                    const res = await fetch(image)
                    imageSource = Buffer.from(await res.arrayBuffer())
                } else {
                    imageSource = fs.readFileSync(image)
                }
            } else {
                imageSource = image
            }

            const { imageMessage } = await prepareWAMessageMedia({
                image: imageSource
            }, {
                upload: conn.waUploadToServer,
                mediaTypeOverride: 'thumbnail-link'
            })

            return conn.sendMessage(jid, {
                text,
                linkPreview: {
                    'matched-text': matchedText,
                    title,
                    description,
                    previewType,
                    jpegThumbnail: imageMessage?.jpegThumbnail,
                    ...(highQuality ? { highQualityThumbnail: imageMessage } : {}),
                    ...options
                },
                contextInfo: {
                    ...(options.contextInfo || {})
                }
            }, { quoted })
        }
},
        sendButton: {
        /**
     * Kirim pesan interaktif dengan berbagai jenis button ke WhatsApp
     *
     * Mendukung DUA gaya pemanggilan:
     *
     * 1) Gaya nativeFlow (nativeFlow / carousel) — dipilih otomatis jika `opts`
     *    berisi salah satu dari: `nativeFlow`, `cards`, `image`, `video`, `caption`,
     *    atau `text` (tanpa `body`/`buttons`).
     *
     * @example
     * // --- Native Flow
     * conn.sendButton(jid, {
     *   image: { url: './path/to/image.jpg' },
     *   caption: '🗄️️ Interactive!',
     *   footer: 'My Bot',
     *   optionText: '👉🏻 Select Options',   // Optional, bungkus semua nativeFlow jadi 1 list
     *   optionTitle: '📄 Select Options',   // Optional
     *   offerText: '🏷️ Newest Coupon!',     // Optional
     *   offerCode: 'My Bot',     // Optional
     *   offerUrl: 'https://example.com', // Optional
     *   offerExpiration: Date.now() + 3_600_000, // Optional
     *   nativeFlow: [
     *     { text: '👋🏻 Greeting', id: '#Greeting', icon: 'review' },
     *     { text: '📞 Call', call: '628123456789' },
     *     { text: '📋 Copy', copy: 'My Bot' },
     *     { text: '🌐 Source', url: 'https://example.com', useWebview: true },
     *     {
     *       text: '📋 Select',
     *       sections: [
     *         { title: '✨ Section 1', rows: [{ header: '', title: '🏷️ Coupon', description: '', id: '#CouponCode' }] },
     *         { title: '✨ Section 2', highlight_label: '🔥 Popular', rows: [{ header: '', title: '💭 Secret Ingredient', description: '', id: '#SecretIngredient' }] }
     *       ],
     *       icon: 'default'
     *     }
     *   ],
     *   interactiveAsTemplate: false, // Optional
     * }, quoted)
     *
     * @example
     * // --- Tagihan Pembayaran (payment_key_info)
     * // Kalau nativeFlow cuma berisi 1 button `payment`, additionalNodes otomatis
     * // pakai name: 'payment_key_info' (bukan 'mixed'), sesuai spek WhatsApp.
     * conn.sendButton(jid, {
     *   text: 'Halo, silakan selesaikan pembayaran kamu ke akun *DANA* di bawah ini ya!',
     *   footer: '© Secure Payment Gateway',
     *   nativeFlow: [{
     *     payment: {
     *       currency: 'IDR',           // Optional, default 'IDR'
     *       amount: 0,                 // Optional, default 0 (nominal ditentukan manual di app)
     *       offset: 100,               // Optional, default 100
     *       referenceId: 'INV-' + Date.now(), // Optional, auto-generate jika kosong
     *       itemName: 'Layanan via DANA',     // Optional, nama item di rincian order
     *       accountKey: '+62 81234567891',    // Nomor/akun tujuan pembayaran
     *       accountName: 'DANA',               // Nama tampilan akun
     *       institution: 'DANA',               // Kode institusi/e-wallet/bank
     *       fullName: 'Nama Pemilik Akun'       // Nama pemilik akun tujuan
     *     }
     *   }]
     * }, quoted)
     *
     * @example
     * // --- Carousel & Native Flow
     * conn.sendButton(jid, {
     *   text: '🗂️ Interactive with Carousel!',
     *   footer: 'My Bot',
     *   cards: [
     *     {
     *       image: { url: './path/to/image.jpg' },
     *       caption: '🖼️ Image 1',
     *       footer: '🏷️️ Pinterest',
     *       nativeFlow: [{ text: '🌐 Source', url: 'https://example.com', useWebview: true }]
     *     },
     *     {
     *       image: { url: './path/to/image.jpg' },
     *       caption: '🖼️ Image 2',
     *       footer: '🏷️ Pinterest',
     *       offerText: '🏷️ New Coupon!',
     *       offerCode: 'My Bot',
     *       offerUrl: 'https://example.com',
     *       offerExpiration: Date.now() + 3_600_000,
     *       nativeFlow: [{ text: '🌐 Source', url: 'https://example.com' }]
     *     },
     *     {
     *       image: { url: './path/to/image.jpg' },
     *       caption: '🖼️ Image 3',
     *       footer: '🏷️ Pinterest',
     *       optionText: '👉🏻 Select Options',
     *       optionTitle: '👉🏻 Select Options',
     *       nativeFlow: [
     *         { text: '🛒 Product', id: '#Product', icon: 'default' },
     *         { text: '🌐 Source', url: 'https://example.com' }
     *       ]
     *     }
     *   ]
     * }, quoted)
     *
     * 2) Gaya lama (legacy) — { head, body, footer, buttons, sections, copy, url, order, attachment, type }.
     *    Tetap didukung penuh untuk kompatibilitas kode lama.
     *
     * @param {string} jid - ID tujuan (user/group)
     * @param {Object} opts - Opsi pesan
     * @param {string} [opts.head=''] - Judul header pesan
     * @param {string} [opts.body=''] - Isi/konten utama pesan
     * @param {string} [opts.footer=''] - Teks footer pesan
     * 
     * @param {Array<[string, string]>} [opts.buttons=[]]
     * Button quick reply. Format: [display_text, id]
     * @example
     * buttons: [
     *   ['Pilihan 1', 'id_1'],
     *   ['Pilihan 2', 'id_2']
     * ]
     * 
     * @param {Array|Array<Array>} [opts.sections=[]]
     * List menu (single/multi section).
     * - Single: [[title, rows]] atau [rows]
     * - Multi:  [['Section A', rows], ['Section B', rows]]
     * @example
     * // Single section
     * sections: ['Pilih Menu', [
     *   { header: 'Item 1', title: 'Deskripsi', id: 'item_1' }
     * ]]
     * // Multi section
     * sections: [
     *   ['Section A', [{ header: 'Item 1', title: 'Desc', id: 'a_1' }]],
     *   ['Section B', [{ header: 'Item 2', title: 'Desc', id: 'b_1' }]]
     * ]
     * 
     * @param {Array<[string, string]>} [opts.copy=[]]
     * Button salin teks. Format: [display_text, copy_code]
     * @example
     * copy: [
     *   ['Salin Kode', 'PROMO123'],
     *   ['Salin No. Rekening', '1234567890']
     * ]
     * 
     * @param {Array<[string, string, string?]>} [opts.url=[]]
     * Button buka URL. Format: [display_text, url, merchant_url?]
     * merchant_url otomatis sama dengan url jika tidak diisi
     * @example
     * url: [
     *   ['Buka Website', 'https://example.com'],
     *   ['Buka Docs', 'https://docs.example.com', 'https://merchant.example.com']
     * ]
     * 
     * @param {Array<string>} [opts.order=['list','button','copy','url']]
     * Urutan tampilan button. Ubah untuk mengatur posisi
     * @example
     * order: ['button', 'url', 'copy', 'list'] // button muncul paling atas
     * 
     * @param {Buffer|string|null} [opts.attachment=null]
     * Lampiran media. Bisa Buffer atau URL string
     * @example
     * attachment: 'https://example.com/image.jpg'
     * attachment: fs.readFileSync('./file.pdf')
     * 
     * @param {string|Array|null} [opts.type=null]
     * Tipe media. Jika null, otomatis terdeteksi.
     * - String: 'image' | 'video' | 'document' | 'location'
     * - Array untuk document: ['document', [fileName, mimetype?]]
     * - Array untuk location: ['location', [name, address]]
     * @example
     * type: 'image'
     * type: 'video'
     * type: ['document', ['laporan.pdf', 'application/pdf']]
     * type: ['location', ['Nama Tempat', 'Alamat Lengkap']]
     * 
     * @param {Object} [quoted] - Pesan yang di-reply/quote
     * @param {Object} [options] - Opsi tambahan relay
     * 
     * @example
     * // Pesan teks dengan semua jenis button
     * conn.sendButton(jid, {
     *   head: 'Judul',
     *   body: 'Isi pesan',
     *   footer: 'Footer',
     *   buttons: [['Reply Ini', 'reply_1']],
     *   sections: ['Pilih Menu', [{ header: 'Item', title: 'Desc', id: 'item_1' }]],
     *   copy: [['Salin Kode', 'KODE123']],
     *   url: [['Buka Web', 'https://example.com']]
     * }, quoted)
     * 
     * @example
     * // Pesan dengan gambar
     * conn.sendButton(jid, {
     *   body: 'Lihat gambar ini',
     *   attachment: 'https://example.com/photo.jpg',
     *   url: [['Info Lebih', 'https://example.com']]
     * }, quoted)
     * 
     * @example
     * // Pesan dengan dokumen
     * conn.sendButton(jid, {
     *   body: 'File terlampir',
     *   attachment: fs.readFileSync('./doc.pdf'),
     *   type: ['document', ['Nama File.pdf', 'application/pdf']],
     *   copy: [['Salin Password', 'pass123']]
     * }, quoted)
     * 
     * @example
     * // Pesan lokasi
     * conn.sendButton(jid, {
     *   body: 'Lokasi kami',
     *   attachment: 'https://example.com/thumb.jpg',
     *   type: ['location', ['Toko Kami', 'Jl. Contoh No. 1, Jakarta']],
     *   url: [['Google Maps', 'https://maps.google.com/?q=...']]
     * }, quoted)
     */
        async value (jid, opts = {}, quoted, options) {
        // ---- native-flow style: nativeFlow + optional carousel (`cards`) ----
        if (isNativeFlowStyle(opts)) {
            const isGroupJid = typeof jid === 'string' && jid.endsWith('@g.us')
            const buildAdditionalNodes = (buttons = []) => [{
                tag: 'biz',
                attrs: {},
                content: [{
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{ tag: 'native_flow', attrs: nfNativeFlowAttrs(buttons) }]
                }]
            }, ...(isGroupJid ? [] : [{ tag: 'bot', attrs: { biz_bot: '1' } }])]

            // NOTE: sengaja TIDAK pakai generateWAMessageFromContent di sini.
            // generateWAMessageFromContent mem-parse content lewat proto.Message.create(),
            // yang bisa diam-diam menghapus/mengubah field non-standar semacam
            // messageParamsJson (limited_time_offer, dst) sehingga hasil relay-nya
            // rusak dan WhatsApp reject tanpa alasan (`undefined`). relayMessage
            // langsung dengan object interactiveMessage mentah (persis raw payload)
            // terbukti jalan, jadi kita replikasi itu di sini.
            const safeQuoted = (quoted && quoted.message)
                ? { ...quoted, key: { fromMe: false, id: quoted.key?.id || 'BAE5' + Math.random().toString(16).slice(2, 10).toUpperCase(), ...(quoted.key || {}) } }
                : undefined

            const buildContextInfo = (base = {}) => {
                const ctx = {
                    mentionedJid: opts.mentions || [],
                    groupMentions: [],
                    statusAttributions: [],
                    ...base
                }
                if (safeQuoted) {
                    ctx.stanzaId = safeQuoted.key.id
                    ctx.participant = jidNormalizedUser(safeQuoted.key.participant || safeQuoted.key.remoteJid || jid)
                    ctx.quotedMessage = safeQuoted.message
                }
                return ctx
            }

            const genMessageId = () => options?.messageId || 'BAE5' + crypto.randomBytes(8).toString('hex').toUpperCase()

            if (Array.isArray(opts.cards) && opts.cards.length) {
                const cards = []
                for (const card of opts.cards) {
                    const interactive = await nfBuildInteractive(card)
                    cards.push({ ...interactive, footer: { text: String(card.footer || opts.footer || '') } })
                }
                const content = {
                    interactiveMessage: {
                        body: { text: String(opts.text || opts.caption || opts.body || '') },
                        footer: { text: String(opts.footer || '') },
                        carouselMessage: { cards },
                        contextInfo: buildContextInfo()
                    }
                }
                // Cards can each carry different button types, so the outer
                // additionalNodes falls back to 'mixed' for carousels.
                const additionalNodes = buildAdditionalNodes([])
                const messageId = genMessageId()
                await conn.relayMessage(jid, content, { messageId, additionalNodes, ...(options || {}) })
                return { key: { remoteJid: jid, fromMe: true, id: messageId }, message: content }
            }

            const interactive = await nfBuildInteractive(opts)
            const content = {
                interactiveMessage: {
                    ...interactive,
                    contextInfo: buildContextInfo(interactive.contextInfo || {}),
                    ...(opts.interactiveAsTemplate ? { interactiveAsTemplate: true } : {})
                }
            }
            const additionalNodes = buildAdditionalNodes(interactive.nativeFlowMessage?.buttons)
            const messageId = genMessageId()
            await conn.relayMessage(jid, content, { messageId, additionalNodes, ...(options || {}) })
            return { key: { remoteJid: jid, fromMe: true, id: messageId }, message: content }
        }

        // ---- legacy style: { head, body, footer, buttons, sections, copy, url, order, attachment, type } ----
        const { head = '', body = '', footer = '', buttons = [], sections = [], copy = [], url = [], order = ['list', 'button', 'copy', 'url'], attachment = null, type = null } = opts
        const hasButtons    = buttons.length > 0
        const hasSections   = sections.length > 0
        const hasCopy       = copy.length > 0
        const hasUrl        = url.length > 0
        const hasAttachment = !!attachment
        const isMultiSections = hasSections && Array.isArray(sections[0]) && (
        typeof sections[0][0] === 'string' || Array.isArray(sections[0][0])
        )
        let parsedButtons = []
        if (isMultiSections) {
        parsedButtons = sections.map((item) => {
            let title = ' '
            let sectionList = []
            if (typeof item[0] === 'string') {
                title = item[0]
                sectionList = item[1]
            } else {
                sectionList = item
            }
            return {
                name: 'single_select',
                buttonParamsJson: JSON.stringify({ title, sections: sectionList })
            }
        })
        } else if (hasSections) {
        let parsedSections = []
        let selectTitle = ' '
        if (typeof sections[0] === 'string') {
            selectTitle = sections[0]
            parsedSections = sections[1]
        } else {
            parsedSections = sections
        }
        parsedButtons = [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify({ title: selectTitle, sections: parsedSections })
        }]
        }
        const quickButtons = hasButtons
        ? buttons.map(([display_text, id]) => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text, id })
        }))
        : []
        const copyButtons = hasCopy
        ? copy.map(([display_text, copy_code]) => ({
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({ display_text, copy_code })
        }))
        : []
        const urlButtons = hasUrl
        ? url.map(([display_text, url_link, merchant_url]) => ({
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text,
                url: url_link,
                merchant_url: merchant_url ?? url_link
            })
        }))
        : []
        // Susun urutan button sesuai parameter order
        const buttonGroups = {
        list:   parsedButtons,
        button: quickButtons,
        copy:   copyButtons,
        url:    urlButtons
        }
        const mappedButtons = order
        .filter(key => key in buttonGroups)
        .flatMap(key => buttonGroups[key])
        const additionalNodes = [{
        tag: 'biz',
        attrs: {},
        content: [{
            tag: 'interactive',
            attrs: { type: 'native_flow', v: '1' },
            content: [{ tag: 'native_flow', attrs: nfNativeFlowAttrs(mappedButtons) }]
        }]
        }]
        // ── Normalize type ──────────────────────────────────────────────
        let typeKey   = null
        let typeExtra = null
        if (Array.isArray(type)) {
        typeKey   = type[0]
        typeExtra = Array.isArray(type[1]) ? type[1] : null
        } else if (typeof type === 'string') {
        typeKey = type
        }
        const isLocation = typeKey === 'location'
        const isDocument = typeKey === 'document'
        // ───────────────────────────────────────────────────────────────
        let header = {}
        if (isLocation) {
        const locName    = typeExtra?.[0] ?? ''
        const locAddress = typeExtra?.[1] ?? ''
        const thumb = hasAttachment
            ? await conn.resize(
                Buffer.isBuffer(attachment) ? attachment : await fetch(attachment).then(r => r.arrayBuffer()).then(Buffer.from),
                300, 300
            )
            : null
        header = {
            hasMediaAttachment: true,
            locationMessage: {
                degreesLatitude: 0,
                degreesLongitude: 0,
                name: locName,
                address: locAddress,
                ...(thumb && { jpegThumbnail: thumb.toString('base64') })
            }
        }
        } else if (hasAttachment) {
        if (isDocument) {
            const fileName = typeExtra?.[0] ?? ''
            let   mimetype = typeExtra?.[1] ?? null
            const buffer = Buffer.isBuffer(attachment)
                ? attachment
                : await fetch(attachment).then(r => r.arrayBuffer()).then(Buffer.from)
            if (!mimetype) {
                try {
                    const img = await Jimp.read(buffer)
                    mimetype = img.mime ?? 'application/octet-stream'
                } catch {
                    mimetype = 'application/octet-stream'
                }
            }
            const thumb = await conn.resize(buffer, 300, 300)
            const media = await prepareWAMessageMedia(
                { document: buffer },
                { upload: conn.waUploadToServer }
            )
            header = {
                title: head,
                hasMediaAttachment: true,
                documentMessage: {
                    ...media.documentMessage,
                    mimetype,
                    jpegThumbnail: thumb.toString('base64'),
                    fileLength: '99999999999999',
                    ...(fileName && { fileName })
                }
            }
        } else {
            let resolvedType = typeKey
            if (!resolvedType) {
                try {
                    const buffer = Buffer.isBuffer(attachment)
                        ? attachment
                        : await fetch(attachment).then(r => r.arrayBuffer()).then(Buffer.from)
                    const hex = buffer.slice(0, 12).toString('hex')
                    const isVideo = (hex.startsWith('000000') && (hex.includes('66747970') || hex.includes('6d6f6f76') || hex.includes('6d646174')))
                        || buffer.slice(0, 4).toString() === 'RIFF'
                        || buffer.slice(0, 4).toString('hex') === '1a45dfa3'
                    if (isVideo) {
                        resolvedType = 'video'
                    } else {
                        await Jimp.read(buffer)
                        resolvedType = 'image'
                    }
                } catch {
                    const url = typeof attachment === 'string' ? attachment : ''
                    const videoExt = /\.(mp4|mkv|avi|mov|webm)$/i
                    resolvedType = videoExt.test(url) ? 'video' : 'document'
                }
            }
            const media = await prepareWAMessageMedia(
                { [resolvedType]: Buffer.isBuffer(attachment) ? attachment : { url: attachment } },
                { upload: conn.waUploadToServer }
            )
            header = { title: head, hasMediaAttachment: true, ...media }
        }
        } else {
        header = { title: head, subtitle: head, hasMediaAttachment: false }
        }
        return conn.relayMessage(jid, {
        interactiveMessage: {
            header,
            body:   { text: body },
            footer: { text: footer },
            nativeFlowMessage: { buttons: mappedButtons },
            contextInfo: {
                mentionedJid: [],
                groupMentions: [],
                statusAttributions: []
            }
        }
        }, { quoted, additionalNodes })
}
},
        aiRich: {
        /**
     * Membuat instance builder AIRich untuk menyusun pesan "rich response" ala AI
     * (teks markdown, code block, tabel, gambar, video, produk, post, sources, suggestion, dll)
     * lalu mengirimkannya via conn.relayMessage.
     *
     * @example
     * conn.aiRich()
     *   .addText("Halo, ini contoh teks")
     *   .addImage("https://example.com/gambar.jpg")
     *   .addSuggest(["Lanjut", "Batal"])
     *   .send(m.chat, { quoted: m })
     *
     * @returns {AIRich} instance builder AIRich yang siap dirangkai (chaining)
     */
        value() {
            return new AIRich(conn)
        }
},

        cMod: {
            /**
             * cMod
             * @param {String} jid 
             * @param {import('baileys').proto.WebMessageInfo} message 
             * @param {String} text 
             * @param {String} sender 
             * @param {*} options 
             * @returns 
             */
            value(jid, message, text = '', sender = conn.user.jid, options = {}) {
                if (options.mentions && !Array.isArray(options.mentions)) options.mentions = [options.mentions]
                let copy = message.toJSON()
                delete copy.message.messageContextInfo
                delete copy.message.senderKeyDistributionMessage
                let mtype = Object.keys(copy.message)[0]
                let msg = copy.message
                let content = msg[mtype]
                if (typeof content === 'string') msg[mtype] = text || content
                else if (content.caption) content.caption = text || content.caption
                else if (content.text) content.text = text || content.text
                if (typeof content !== 'string') {
                    msg[mtype] = { ...content, ...options }
                    msg[mtype].contextInfo = {
                        ...(content.contextInfo || {}),
                        mentionedJid: options.mentions || content.contextInfo?.mentionedJid || []
                    }
                }
                if (copy.participant) sender = copy.participant = sender || copy.participant
                else if (copy.key.participant) sender = copy.key.participant = sender || copy.key.participant
                if (copy.key.remoteJid.includes('@s.whatsapp.net')) sender = sender || copy.key.remoteJid
                else if (copy.key.remoteJid.includes('@broadcast')) sender = sender || copy.key.remoteJid
                copy.key.remoteJid = jid
                copy.key.fromMe = areJidsSameUser(sender, conn.user.id) || false
                return proto.WebMessageInfo.fromObject(copy)
            },
            enumerable: true,
            writable: true,
        },
        copyNForward: {
            /**
             * Exact Copy Forward
             * @param {String} jid
             * @param {import('baileys').proto.WebMessageInfo} message
             * @param {Boolean|Number} forwardingScore
             * @param {Object} options
             */
            async value(jid, message, forwardingScore = true, options = {}) {
                let vtype
                if (options.readViewOnce && message.message.viewOnceMessage?.message) {
                    vtype = Object.keys(message.message.viewOnceMessage.message)[0]
                    delete message.message.viewOnceMessage.message[vtype].viewOnce
                    message.message = proto.Message.fromObject(
                        JSON.parse(JSON.stringify(message.message.viewOnceMessage.message))
                    )
                    message.message[vtype].contextInfo = message.message.viewOnceMessage.contextInfo
                }
                let mtype = getContentType(message.message)
                let m = generateForwardMessageContent(message, !!forwardingScore)
                let ctype = getContentType(m)
                if (forwardingScore && typeof forwardingScore === 'number' && forwardingScore > 1) m[ctype].contextInfo.forwardingScore += forwardingScore
                m[ctype].contextInfo = {
                    ...(message.message[mtype].contextInfo || {}),
                    ...(m[ctype].contextInfo || {})
                }
                m = generateWAMessageFromContent(jid, m, {
                    ...options,
                    userJid: conn.user.jid
                })
                await conn.relayMessage(jid, m.message, { messageId: m.key.id, additionalAttributes: { ...options } })
                return m
            },
            enumerable: true,
            writable: true,
        },
        downloadM: {
            /**
             * Download media message
             * @param {Object} m
             * @param {String} type
             * @param {{
             *  saveToFile?: fs.PathLike | fs.promises.FileHandle;
             *  asStream?: boolean
             * }} opts
             * @returns {Promise<fs.PathLike | fs.promises.FileHandle | Buffer>} the return will string, which is a filename if `opts.saveToFile` is `'true'`
             */
            async value(m, type, opts) {
                let filename
                if (!m || !(m.url || m.directPath)) return Buffer.alloc(0)
                const stream = await downloadContentFromMessage(m, type)
                if (opts.asStream) {
                    // TODO: Support return as stream
                    // return stream
                }
                // Use push to fix performance issue
                let buffers = []
                for await (const chunk of stream) buffers.push(chunk)
                buffers = Buffer.concat(buffers)
                // Destroy the stream
                stream.destroy()
                // If saveToFile is true, call getFile function to save file and then get filename
                if (opts.saveToFile) ({ filename } = await conn.getFile(buffers, true))
                return opts.saveToFile && fs.existsSync(filename) ? filename : buffers
            },
            enumerable: true,
            writable: true,
        },
        parseMention: {
            /**
             * Parses string into mentionedJid(s)
             * @param {String} text
             * @returns {Array<String>}
             */
            value(text = '') {
                return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(v => v[1] + '@s.whatsapp.net')
            },
            enumerable: true,
            writable: true,
        },
        getName: {
            /**
             * Get name from jid
             * @param {String} jid
             * @param {Boolean} withoutContact
             */
            value(jid = '', withoutContact = false) {
                jid = conn.decodeJid(jid)
                withoutContact = conn.withoutContact || withoutContact
                let v
                if (jid.endsWith('@g.us')) return (async () => {
                    v = await store.fetchGroupMetadata(jid, conn.groupMetadata) || {}
                    return (v.name || v.subject || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international'))
                })()
                else v = jid === '0@s.whatsapp.net' ? {
                    jid,
                    vname: 'WhatsApp'
                } : areJidsSameUser(jid, conn.user?.id || '') ?
                    conn.user :
                    (store.getContact(jid) || {})
                return (withoutContact ? '' : v.name) || v.subject || v.vname || v.notify || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
            },
            enumerable: true,
            writable: true,
        },
        loadMessage: {
            /**
             * 
             * @param {String} messageID 
             * @returns {import('baileys').proto.WebMessageInfo}
             */
            value(jid, id) {
                if (!jid && !id) return null
                // if only 1 argument is passed, it is assumed to be a message id not a jid
                if (jid && !id) [id, jid] = [jid, null]
                return jid && id ? store.loadMessage(jid, id) : store.loadMessage(id)
            },
            enumerable: true,
            writable: true,
        },
        // TODO: Fix xml-notwell-format
        sendGroupV4Invite: {
            /**
             * sendGroupV4Invite
             * @param {String} jid 
             * @param {*} participant 
             * @param {String} inviteCode 
             * @param {Number} inviteExpiration 
             * @param {String} groupName 
             * @param {String} caption 
             * @param {Buffer} jpegThumbnail
             * @param {*} options 
             */
            async value(jid, participant, inviteCode, inviteExpiration, groupName = 'unknown subject', caption = 'Invitation to join my WhatsApp group', jpegThumbnail, options = {}) {
                const msg = proto.Message.fromObject({
                    groupInviteMessage: proto.GroupInviteMessage.fromObject({
                        inviteCode,
                        inviteExpiration: parseInt(inviteExpiration) || + new Date(new Date + (3 * 86400000)),
                        groupJid: jid,
                        groupName: (groupName ? groupName : await conn.getName(jid)) || null,
                        jpegThumbnail: Buffer.isBuffer(jpegThumbnail) ? jpegThumbnail.toString('base64') : null,
                        caption
                    })
                })
                const message = generateWAMessageFromContent(participant, msg, options)
                await conn.relayMessage(participant, message.message, { messageId: message.key.id, additionalAttributes: { ...options } })
                return message
            },
            enumerable: true,
            writable: true,
        },
        serializeM: {
            /**
             * Serialize Message, so it easier to manipulate
             * @param {import('baileys').proto.WebMessageInfo} m
             */
            value(m) {
                return smsg(conn, m)
            },
            writable: true,
        },
        user: {
            get() {
                Object.assign(botUser, conn.authState.creds.me || {})
                return {
                    ...botUser,
                    jid: botUser.id?.decodeJid?.() || botUser.id,
                }
            },
            set(value) {
                Object.assign(botUser, value)
            },
            enumerable: true,
            configurable: true,
        }
    })
    return sock
}
/**
 * Serialize Message
 * @param {ReturnType<typeof makeWASocket>} conn 
 * @param {import('baileys').proto.WebMessageInfo} m 
 * @param {Boolean} hasParent 
 */
// ─────────────────────────────────────────────────────────────
// [ LID RESOLVER ] — dulu file terpisah (tools/jid_resolver.js),
// digabung ke sini karena satu domain sama getter sender/quoted.sender
// di bawah: getter-getter itu BACA cache yang ditulis fungsi-fungsi ini.
// Cuma handler.js yang MANGGIL resolveLidToNumber/updateUserMapping
// (harus async, dipanggil sekali di awal pipeline sebelum dispatch ke
// plugin) — getter di bawah sini tetap sync, cuma baca cache-nya.
//
// decodeJid/isLidJid/isPhoneJid disamakan dengan pola lib/lid.js milik
// Weabot: pakai jidDecode/jidNormalizedUser resmi dari baileys, bukan
// reimplementasi manual, supaya perilakunya konsisten dengan apa yang
// baileys sendiri anggap sebagai JID valid.
// ─────────────────────────────────────────────────────────────

/**
 * @param {string} jid
 * @returns {string}
 */
function decodeJid(jid) {
    if (!jid) return jid
    if (/:\d+@/gi.test(jid)) {
        const decoded = jidDecode(jid) || {}
        return decoded.user && decoded.server ? `${decoded.user}@${decoded.server}` : jid
    }
    try {
        return jidNormalizedUser(jid)
    } catch {
        return jid
    }
}

/**
 * @param {string} jid
 * @returns {boolean}
 */
function isLidJid(jid) {
    return typeof jid === 'string' && decodeJid(jid)?.endsWith('@lid')
}

/**
 * @param {string} jid
 * @returns {boolean}
 */
function isPhoneJid(jid) {
    return typeof jid === 'string' && decodeJid(jid)?.endsWith('@s.whatsapp.net')
}


/**
 * Normalisasi participant handle kasus id berbentuk object (bukan string)
 * Contoh: { id: { id: '246625645646049@lid', phoneNumber: '13057071888@s.whatsapp.net' } }
 * @param {object} participant
 * @returns {{ lid: string|null, number: string|null }}
 */
function normalizeParticipant(participant) {
    if (!participant) return { lid: null, number: null }

    let lid = null
    let number = null

    const rawId = participant.id
    if (rawId && typeof rawId === 'object') {
        const inner = rawId
        const innerId = decodeJid(inner.id || inner.jid || '')
        if (isLidJid(innerId)) lid = innerId
        const innerPn = inner.phoneNumber || inner.pn || inner.phone_number || ''
        if (isPhoneJid(innerPn)) number = decodeJid(innerPn)
        else if (innerPn) {
            const cleaned = String(innerPn).replace(/\D/g, '')
            if (cleaned.length >= 7) number = cleaned + '@s.whatsapp.net'
        }
    } else if (typeof rawId === 'string') {
        const decoded = decodeJid(rawId)
        if (isLidJid(decoded)) lid = decoded
        else if (isPhoneJid(decoded)) number = decoded
    }

    const pn = participant.phoneNumber || participant.pn || participant.phone_number
    if (pn) {
        if (isPhoneJid(pn)) number = decodeJid(pn)
        else {
            const cleaned = String(pn).replace(/\D/g, '')
            if (cleaned.length >= 7) number = cleaned + '@s.whatsapp.net'
        }
    }

    if (isLidJid(participant.lid)) lid = decodeJid(participant.lid)

    return { lid, number }
}

/**
 * Cek apakah participant cocok dengan lidNumber yang dicari
 */
function participantMatchesLid(participant, lidNumber) {
    const lidNum = lidNumber.split('@')[0]
    const { lid } = normalizeParticipant(participant)
    if (lid === lidNumber) return true
    if (lid?.split('@')[0] === lidNum) return true
    const rawId = participant.id
    if (rawId && typeof rawId === 'object') {
        const innerId = String(rawId.id || rawId.jid || '')
        if (innerId === lidNumber || innerId.split('@')[0] === lidNum) return true
    }
    return false
}

/**
 * Cocokkan participant dengan jid target.
 * Mendukung addressingMode 'lid': participant.id bisa @lid,
 * sedangkan phoneNumber berisi nomor asli @s.whatsapp.net.
 * @param {object} conn - Baileys connection
 * @param {object} p - participant object
 * @param {string} targetJid
 * @returns {boolean}
 */
export function matchParticipant(conn, p, targetJid) {
    if (!p || !targetJid) return false
    const decoded = decodeJid(p.id) || conn?.decodeJid?.(p.id)
    if (decoded === targetJid) return true
    const pn = p.phoneNumber || p.pn || p.phone_number || ''
    if (pn && pn === targetJid) return true
    const { number, lid } = normalizeParticipant(p)
    if (number && number === targetJid) return true
    if (lid && lid === targetJid) return true
    const targetNum = targetJid.split('@')[0]
    if (number && number.split('@')[0] === targetNum) return true
    if (pn && pn.split('@')[0] === targetNum) return true
    return false
}

/**
 * Cari nomor dari group metadata, coba cache dulu lalu fetch fresh jika perlu
 */
async function resolveFromGroup(lidNumber, groupJid, conn) {
    const tryMetadata = (metadata) => {
        if (!metadata?.participants) return null
        for (const p of metadata.participants) {
            if (!participantMatchesLid(p, lidNumber)) continue
            const { number } = normalizeParticipant(p)
            if (number) return number
        }
        return null
    }
    try {
        const cached = await Connection.store.fetchGroupMetadata(groupJid, conn.groupMetadata)
        const found = tryMetadata(cached)
        if (found) return found
    } catch (e) {
        console.warn(`[LID] fetchGroupMetadata (cache) gagal ${groupJid}:`, e.message)
    }
    try {
        const fresh = await conn.groupMetadata(groupJid)
        const found = tryMetadata(fresh)
        if (found) return found
        // Ketemu grupnya, tapi gak ada participant yang match lidNumber ini
        // ATAU participant-nya ada tapi phoneNumber-nya kosong (privasi WA
        // nyembunyiin nomor asli dari bot). Dump bentuk data participant
        // biar keliatan field apa aja yang sebenarnya ada.
        const sample = fresh?.participants?.slice(0, 3).map(p => ({
            id: typeof p.id === 'object' ? p.id : p.id,
            phoneNumber: p.phoneNumber || p.pn || null,
            lid: p.lid || null
        }))
        console.warn(`[LID] ${groupJid} fetched fresh, tapi ${lidNumber} tidak match. Contoh bentuk participant:`, JSON.stringify(sample))
    } catch (e) {
        console.error(`[LID] Failed fresh group fetch ${groupJid}:`, e.message)
    }
    return null
}

/**
 * Scan semua grup yang diketahui bot untuk mencari LID (untuk private chat)
 */
async function resolveFromAllGroups(lidNumber, conn) {
    const knownGroups = Object.keys(Connection.store?.chats ?? {}).filter(j => j.endsWith('@g.us'))
    for (const groupJid of knownGroups) {
        try {
            const cached = Connection.store?.chats?.[groupJid]?.metadata
            if (cached?.participants) {
                for (const p of cached.participants) {
                    if (!participantMatchesLid(p, lidNumber)) continue
                    const { number } = normalizeParticipant(p)
                    if (number) return number
                }
            }
        } catch (e) {}
    }
    return null
}

/**
 * Resolve LID ke nomor asli (@s.whatsapp.net)
 * @param {string} lidNumber
 * @param {object} conn - Baileys connection
 * @param {string} chatId
 * @returns {Promise<string|null>}
 */
export async function resolveLidToNumber(lidNumber, conn, chatId) {
    if (!lidNumber || !lidNumber.endsWith('@lid')) return null

    // 1. findUserId — cara tercepat, langsung tanya WA
    try {
        if (typeof conn.findUserId !== 'function') {
            console.warn(`[LID] conn.findUserId bukan function di versi baileys ini — skip step 1 (${lidNumber})`)
        } else {
            const result = await conn.findUserId(lidNumber)
            const pn = result?.phoneNumber
            if (pn?.endsWith('@s.whatsapp.net')) return pn
            console.warn(`[LID] findUserId(${lidNumber}) tidak balikin phoneNumber valid:`, JSON.stringify(result))
        }
    } catch (e) {
        console.warn(`[LID] findUserId(${lidNumber}) error:`, e.message)
    }

    // 2. Group metadata — fallback jika findUserId gagal
    if (chatId?.endsWith('@g.us')) {
        const found = await resolveFromGroup(lidNumber, chatId, conn)
        if (found) return found
        console.warn(`[LID] Tidak ketemu di group metadata chat ${chatId} untuk ${lidNumber}`)
    }

    // 3. Scan semua grup yang diketahui
    const fromAllGroups = await resolveFromAllGroups(lidNumber, conn)
    if (fromAllGroups) return fromAllGroups

    console.warn(`[LID] GAGAL resolve ${lidNumber} lewat semua metode (findUserId, group metadata chat ini, scan semua grup dikenal)`)
    return null
}

/**
 * Update mapping user di database.
 * Selalu gunakan @s.whatsapp.net sebagai primary key.
 * @param {string} senderJid
 * @param {string|null} actualNumber
 * @param {string|null} lidNumber
 * @returns {Promise<string>} key yang valid untuk digunakan handler
 */
export async function updateUserMapping(senderJid, actualNumber, lidNumber) {
    if (!senderJid) return senderJid

    const primaryKey = actualNumber?.endsWith('@s.whatsapp.net') ? actualNumber
        : senderJid.endsWith('@s.whatsapp.net') ? senderJid
        : null

    const workingKey = primaryKey || senderJid

    if (!db.data.users[workingKey] || typeof db.data.users[workingKey] !== 'object') {
        db.data.users[workingKey] = {}
    }

    const user = db.data.users[workingKey]
    let changed = false

    if (actualNumber?.endsWith('@s.whatsapp.net') && user.number !== actualNumber) {
        user.number = actualNumber
        changed = true
    }

    if (lidNumber?.endsWith('@lid') && user.lid !== lidNumber) {
        user.lid = lidNumber
        changed = true
    }

    // Migrate data dari @lid key ke @s.whatsapp.net key
    if (workingKey.endsWith('@lid') && primaryKey && primaryKey !== workingKey) {
        if (!db.data.users[primaryKey] || typeof db.data.users[primaryKey] !== 'object') {
            db.data.users[primaryKey] = {}
        }
        for (const [k, v] of Object.entries(user)) {
            if (db.data.users[primaryKey][k] === undefined || db.data.users[primaryKey][k] === null) {
                db.data.users[primaryKey][k] = v
            }
        }
        db.data.users[primaryKey].number = primaryKey
        db.data.users[primaryKey].lid = lidNumber || workingKey
        delete db.data.users[workingKey]
        changed = true
    }

    // Bersihkan orphan @lid entry
    if (primaryKey && lidNumber && db.data.users[lidNumber] && primaryKey !== lidNumber) {
        const lidEntry = db.data.users[lidNumber]
        const target = db.data.users[primaryKey] || {}
        for (const [k, v] of Object.entries(lidEntry)) {
            if (target[k] === undefined || target[k] === null) {
                target[k] = v
            }
        }
        db.data.users[primaryKey] = target
        delete db.data.users[lidNumber]
        changed = true
    }

    if (changed) {
        await db.write().catch(e => console.error('[MAPPING] Failed to save:', e))
    }

    return primaryKey || workingKey
}

/**
 * Auto merge LID users — gabungkan data LID ke nomor asli lalu hapus LID entry
 * @returns {Promise<number>} jumlah key yang dihapus
 */
export async function autoMergeLidUsers() {
    try {
        if (!db.data || !db.data.users) return 0

        let merged = 0
        const toDelete = []

        for (const [key, user] of Object.entries(db.data.users)) {
            if (key.endsWith('@lid') && user.number && user.number.endsWith('@s.whatsapp.net')) {
                const targetKey = user.number

                if (!db.data.users[targetKey]) {
                    db.data.users[targetKey] = {}
                }

                const target = db.data.users[targetKey]
                const source = user
                let changed = false

                for (const [field, value] of Object.entries(source)) {
                    if (field === 'number' || field === 'lid') continue

                    if (target[field] === undefined || target[field] === null || target[field] === '') {
                        target[field] = value
                        changed = true
                    } else if (typeof value === 'number' && !isNaN(value)) {
                        if (field === 'exp') {
                            target[field] = (target[field] || 0) + value
                            changed = true
                        } else if (field === 'limit' || field === 'level' || field === 'warn') {
                            if (value > (target[field] || 0)) {
                                target[field] = value
                                changed = true
                            }
                        } else if (field === 'regTime' && value !== -1) {
                            if (target[field] === -1 || value < (target[field] || 0)) {
                                target[field] = value
                                changed = true
                            }
                        } else if ((field === 'daily' || field === 'premiumTime') && value > (target[field] || 0)) {
                            target[field] = value
                            changed = true
                        }
                    } else if (typeof value === 'boolean') {
                        if (value === true && target[field] !== true) {
                            target[field] = true
                            changed = true
                        }
                    } else if (typeof value === 'string' && value && (!target[field] || target[field] === '')) {
                        target[field] = value
                        changed = true
                    }
                }

                target.number = targetKey
                if (source.lid && !target.lid) target.lid = source.lid

                if (changed) merged++
                toDelete.push(key)
            }
        }

        for (const key of toDelete) delete db.data.users[key]

        if (toDelete.length > 0) await db.write()

        return toDelete.length
    } catch (err) {
        console.error('[Merge] Error:', err.message)
        return 0
    }
}


export function smsg(conn, m, hasParent) {
    if (!m) return m
    /**
     * @type {import('baileys').proto.WebMessageInfo}
     */
    let M = proto.WebMessageInfo
    m = M.fromObject(m)
    Object.defineProperty(m, 'conn', { enumerable: false, writable: true, value: conn })
    let protocolMessageKey
    if (m.message) {
        if (m.mtype == 'protocolMessage' && m.msg.key) {
            protocolMessageKey = m.msg.key
            if (protocolMessageKey == 'status@broadcast') protocolMessageKey.remoteJid = m.chat
            if (!protocolMessageKey.participant || protocolMessageKey.participant == 'status_me') protocolMessageKey.participant = m.sender
            protocolMessageKey.fromMe = areJidsSameUser(protocolMessageKey.participant, conn.user.id)
            if (!protocolMessageKey.fromMe && areJidsSameUser(protocolMessageKey.remoteJid, conn.user.id)) protocolMessageKey.remoteJid = m.sender
        }
        if (m.quoted) if (!m.quoted.mediaMessage) delete m.quoted.download
    }
    if (!m.mediaMessage) delete m.download
    try {
        if (protocolMessageKey && m.mtype == 'protocolMessage') conn.ev.emit('messages.delete', { keys: [protocolMessageKey] })
    } catch (e) {
        console.error(e)
    }
    return m
}
// https://github.com/Nurutomo/wabot-aq/issues/490
const MediaType = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']
export function serialize() {
    return Object.defineProperties(proto.WebMessageInfo.prototype, {
        conn: {
            value: Connection.conn,
            enumerable: false,
            writable: true
        },
        id: {
            get() {
                return this.key?.id
            }
        },
        isBaileys: {
            get() {
                return this.id?.startsWith('BAE5') || false
            }
        },
        chat: {
            get() {
                const senderKeyDistributionMessage = this.message?.senderKeyDistributionMessage?.groupId
                return (
                    this.key?.remoteJid ||
                    (senderKeyDistributionMessage &&
                        senderKeyDistributionMessage !== 'status@broadcast'
                    ) || ''
                ).decodeJid()
            }
        },
        isGroup: {
            get() {
                return this.chat.endsWith('@g.us')
            },
            enumerable: true
        },
        sender: {
            get() {
                // Newsletter: pesan dari admin channel (tidak ada participant) = bot sendiri
                if (this.chat?.endsWith('@newsletter')) {
                    const p = this.key?.participant || this.participant
                    if (!p || p === this.chat) {
                        return this.conn?.decodeJid(this.conn?.user?.id) || this.chat
                    }
                    return this.conn?.decodeJid(p) || p
                }
                // Prioritas 1: participantPn langsung dari proto (nomor asli)
                if (this.key?.participantPn) {
                    return this.key.participantPn + '@s.whatsapp.net'
                }
                // Prioritas 2: senderPn (beberapa versi Baileys pakai ini)
                if (this.key?.senderPn) {
                    return this.key.senderPn + '@s.whatsapp.net'
                }
                const rawSender = this.conn?.decodeJid(
                    this.key?.fromMe && this.conn?.user.id ||
                    this.participant ||
                    this.key.participant ||
                    this.chat || ''
                )
                // Prioritas 3: Jika @lid, cari mapping ke @s.whatsapp.net
                if (rawSender?.endsWith?.('@lid')) {
                    if (db.data?.users) {
                        // Cek entry @s.whatsapp.net yang punya lid ini
                        for (const [jid, u] of Object.entries(db.data.users)) {
                            if (jid.endsWith('@s.whatsapp.net') && u?.lid === rawSender) {
                                return jid
                            }
                        }
                        // Cek via field number di entry @lid sendiri
                        const lidUser = db.data.users[rawSender]
                        if (lidUser?.number?.endsWith?.('@s.whatsapp.net')) {
                            return lidUser.number
                        }
                    }
                    // Fallback: kembalikan @lid, handler akan resolve lebih lanjut
                    return rawSender
                }
                return rawSender
            },
            enumerable: true
        },
        fromMe: {
            get() {
                return this.key?.fromMe || areJidsSameUser(this.conn?.user.id, this.sender) || false
            }
        },
        mtype: {
            get() {
                if (!this.message) return undefined
                return getContentType(this.message)
            },
            enumerable: true
        },
        msg: {
            get() {
                if (!this.message) return null
                return this.message[this.mtype]
            }
        },
        mediaMessage: {
            get() {
                if (!this.message) return null
                const Message = ((this.msg?.url || this.msg?.directPath) ? { ...this.message } : extractMessageContent(this.message)) || null
                if (!Message) return null
                const mtype = Object.keys(Message)[0]
                return MediaType.includes(mtype) ? Message : null
            },
            enumerable: true
        },
        mediaType: {
            get() {
                let message
                if (!(message = this.mediaMessage)) return null
                return Object.keys(message)[0]
            },
            enumerable: true,
        },
        quoted: {
            get() {
                /** @type {ReturnType<typeof makeWASocket>} */
                const self = this
                const msg = self.msg
                const contextInfo = msg?.contextInfo
                const quoted = contextInfo?.quotedMessage
                if (!msg || !contextInfo || !quoted) return null
                const type = Object.keys(quoted)[0]
                let q = quoted[type]
                const text = typeof q === 'string' ? q : q.text
                return Object.defineProperties(JSON.parse(JSON.stringify(typeof q === 'string' ? { text: q } : q)), {
                    mtype: {
                        get() {
                            return type
                        },
                        enumerable: true
                    },
                    mediaMessage: {
                        get() {
                            const Message = ((q.url || q.directPath) ? { ...quoted } : extractMessageContent(quoted)) || null
                            if (!Message) return null
                            const mtype = Object.keys(Message)[0]
                            return MediaType.includes(mtype) ? Message : null
                        },
                        enumerable: true
                    },
                    mediaType: {
                        get() {
                            let message
                            if (!(message = this.mediaMessage)) return null
                            return Object.keys(message)[0]
                        },
                        enumerable: true,
                    },
                    id: {
                        get() {
                            return contextInfo.stanzaId
                        },
                        enumerable: true
                    },
                    chat: {
                        get() {
                            return contextInfo.remoteJid || self.chat
                        },
                        enumerable: true
                    },
                    isBaileys: {
                        get() {
                            return this.id?.startsWith('BAE5') || false
                        },
                        enumerable: true
                    },
                    sender: {
                        get() {
                            // participantPn dari quoted context
                            if (contextInfo?.quotedParticipantPn) {
                                return contextInfo.quotedParticipantPn + '@s.whatsapp.net'
                            }
                            const raw = (contextInfo.participant || this.chat || '').decodeJid()
                            // Cek cache di db.data.users jika raw adalah @lid.
                            // Dua arah lookup, sama seperti getter `sender` biasa:
                            if (raw?.endsWith?.('@lid')) {
                                if (db.data?.users) {
                                    // 1. Entry @s.whatsapp.net yang field .lid-nya cocok
                                    //    (ini layout yang dipakai updateUserMapping()).
                                    for (const [jid, u] of Object.entries(db.data.users)) {
                                        if (jid.endsWith('@s.whatsapp.net') && u?.lid === raw) {
                                            return jid
                                        }
                                    }
                                    // 2. Entry ber-key @lid sendiri yang punya field .number
                                    //    (layout alternatif, jaga-jaga).
                                    const lidUser = db.data.users[raw]
                                    if (lidUser?.number?.endsWith?.('@s.whatsapp.net')) {
                                        return lidUser.number
                                    }
                                }
                                return raw
                            }
                            return raw
                        },
                        enumerable: true
                    },
                    fromMe: {
                        get() {
                            return areJidsSameUser(this.sender, self.conn?.user.jid)
                        },
                        enumerable: true,
                    },
                    text: {
                        get() {
                            return text || this.caption || this.contentText || this.selectedDisplayText || ''
                        },
                        enumerable: true
                    },
                    mentionedJid: {
                        get() {
                            const jids = q.contextInfo?.mentionedJid || self.getQuotedObj()?.mentionedJid || []
                            return jids.map(jid => {
                                if (!jid?.endsWith?.('@lid')) return jid
                                if (db.data?.users?.[jid]?.number) return db.data.users[jid].number
                                const contact = Connection.store?.contacts?.[jid]
                                if (contact?.pn) return contact.pn + '@s.whatsapp.net'
                                const lidNum = jid.split('@')[0]
                                const gmd = self.conn?.groupMetadata?.get?.(self.chat) || self.conn?.groupMetadata?.[self.chat]
                                if (gmd?.participants) {
                                    const p = gmd.participants.find(p => p.id?.split('@')[0] === lidNum || p.lid?.split('@')[0] === lidNum)
                                    if (p?.id?.endsWith?.('@s.whatsapp.net')) return p.id
                                }
                                return jid
                            })
                        },
                        enumerable: true
                    },
                    name: {
                        get() {
                            const sender = this.sender
                            return sender ? self.conn?.getName(sender) : null
                        },
                        enumerable: true
                    },
                    vM: {
                        get() {
                            return proto.WebMessageInfo.fromObject({
                                key: {
                                    fromMe: this.fromMe,
                                    remoteJid: this.chat,
                                    id: this.id
                                },
                                message: quoted,
                                ...(self.isGroup ? { participant: this.sender } : {})
                            })
                        }
                    },
                    fakeObj: {
                        get() {
                            return this.vM
                        }
                    },
                    download: {
                        value(saveToFile = false) {
                            const mtype = this.mediaType
                            return self.conn?.downloadM(this.mediaMessage[mtype], mtype.replace(/message/i, ''), { saveToFile })
                        },
                        enumerable: true,
                        configurable: true,
                    },
                    reply: {
                        /**
                         * Reply to quoted message
                         * @param {String|Object} text
                         * @param {String|false} chatId
                         * @param {Object} options
                         */
                        value(text, chatId, options) {
                            return self.conn?.reply(chatId ? chatId : this.chat, text, this.vM, options)
                        },
                        enumerable: true,
                    },
                    copy: {
                        /**
                         * Copy quoted message
                         */
                        value() {
                            const M = proto.WebMessageInfo
                            return smsg(conn, M.fromObject(M.toObject(this.vM)))
                        },
                        enumerable: true,
                    },
                    forward: {
                        /**
                         * Forward quoted message
                         * @param {String} jid
                         *  @param {Boolean} forceForward
                         */
                        value(jid, force = false, options) {
                            return self.conn?.sendMessage(jid, {
                                forward: this.vM, force, ...options
                            }, { ...options })
                        },
                        enumerable: true,
                    },
                    copyNForward: {
                        /**
                         * Exact Forward quoted message
                         * @param {String} jid
                         * @param {Boolean|Number} forceForward
                         * @param {Object} options
                         */
                        value(jid, forceForward = false, options) {
                            return self.conn?.copyNForward(jid, this.vM, forceForward, options)
                        },
                        enumerable: true,
                    },
                    cMod: {
                        /**
                         * Modify quoted Message
                         * @param {String} jid
                         * @param {String} text
                         * @param {String} sender
                         * @param {Object} options
                         */
                        value(jid, text = '', sender = this.sender, options = {}) {
                            return self.conn?.cMod(jid, this.vM, text, sender, options)
                        },
                        enumerable: true,
                    },
                    delete: {
                        /**
                         * Delete quoted message
                         */
                        value() {
                            return self.conn?.sendMessage(this.chat, { delete: this.vM.key })
                        },
                        enumerable: true,
                    },
                    react: {
                        value(text) {
                            return self.conn?.sendMessage(this.chat, {
                                react: {
                                    text,
                                    key: this.vM.key
                                }
                            })
                        },
                        enumerable: true,
                    }
                })
            },
            enumerable: true
        },
        _text: {
            value: null,
            writable: true,
        },
        text: {
            get() {
                const msg = this.msg
                const text = (typeof msg === 'string' ? msg : msg?.text) || msg?.caption || msg?.contentText || ''
                return typeof this._text === 'string' ? this._text : '' || (typeof text === 'string' ? text : (
                    text?.selectedDisplayText ||
                    text?.hydratedTemplate?.hydratedContentText ||
                    text
                )) || ''
            },
            set(str) {
                return this._text = str
            },
            enumerable: true
        },
        mentionedJid: {
            get() {
                const jids = this.msg?.contextInfo?.mentionedJid?.length && this.msg.contextInfo.mentionedJid || []
                return jids.map(jid => {
                    if (!jid?.endsWith?.('@lid')) return jid
                    if (db.data?.users?.[jid]?.number) return db.data.users[jid].number
                    const contact = Connection.store?.contacts?.[jid]
                    if (contact?.pn) return contact.pn + '@s.whatsapp.net'
                    const lidNum = jid.split('@')[0]
                    const gmd = this.conn?.groupMetadata?.get?.(this.chat) || this.conn?.groupMetadata?.[this.chat]
                    if (gmd?.participants) {
                        const p = gmd.participants.find(p => p.id?.split('@')[0] === lidNum || p.lid?.split('@')[0] === lidNum)
                        if (p?.id?.endsWith?.('@s.whatsapp.net')) return p.id
                    }
                    return jid
                })
            },
            enumerable: true
        },
        name: {
            get() {
                return !nullish(this.pushName) && this.pushName || this.conn?.getName(this.sender)
            },
            enumerable: true
        },
        download: {
            value(saveToFile = false) {
                const mtype = this.mediaType
                return this.conn?.downloadM(this.mediaMessage[mtype], mtype.replace(/message/i, ''), { saveToFile })
            },
            enumerable: true,
            configurable: true
        },
        reply: {
            value(text, chatId, options) {
                return this.conn?.reply(chatId ? chatId : this.chat, text, this, options)
            }
        },
        copy: {
            value() {
                const M = proto.WebMessageInfo
                return smsg(this.conn, M.fromObject(M.toObject(this)))
            },
            enumerable: true
        },
        forward: {
            value(jid, force = false, options = {}) {
                return this.conn?.sendMessage(jid, {
                    forward: this, force, ...options
                }, { ...options })
            },
            enumerable: true
        },
        copyNForward: {
            value(jid, forceForward = false, options = {}) {
                return this.conn?.copyNForward(jid, this, forceForward, options)
            },
            enumerable: true
        },
        cMod: {
            value(jid, text = '', sender = this.sender, options = {}) {
                return this.conn?.cMod(jid, this, text, sender, options)
            },
            enumerable: true
        },
        getQuotedObj: {
            value() {
                if (!this.quoted.id) return null
                const q = proto.WebMessageInfo.fromObject(this.conn?.loadMessage(this.quoted.sender, this.quoted.id) || this.conn?.loadMessage(this.quoted.id) || this.quoted.vM)
                return smsg(this.conn, q)
            },
            enumerable: true
        },
        getQuotedMessage: {
            get() {
                return this.getQuotedObj
            }
        },
        delete: {
            value() {
                return this.conn?.sendMessage(this.chat, { delete: this.key })
            },
            enumerable: true
        },
        react: {
            value(text) {
                return this.conn?.sendMessage(this.chat, {
                    react: {
                        text,
                        key: this.key
                    }
                })
            },
            enumerable: true
        }
    })
}
export function logic(check, inp, out) {
    if (inp.length !== out.length) throw new Error('Input and Output must have same length')
    for (let i in inp) if (util.isDeepStrictEqual(check, inp[i])) return out[i]
    return null
}
export function protoType() {
    /**
     * @returns {ArrayBuffer}
     */
    Buffer.prototype.toArrayBuffer = function toArrayBufferV2() {
        const ab = new ArrayBuffer(this.length)
        const view = new Uint8Array(ab)
        for (let i = 0; i < this.length; ++i) {
            view[i] = this[i]
        }
        return ab;
    }
    /**
     * @returns {ArrayBuffer}
     */
    Buffer.prototype.toArrayBufferV2 = function toArrayBuffer() {
        return this.buffer.slice(this.byteOffset, this.byteOffset + this.byteLength)
    }
    /**
     * @returns {Buffer}
     */
    ArrayBuffer.prototype.toBuffer = function toBuffer() {
        const buf = Buffer.alloc(this.byteLength)
        const view = new Uint8Array(this)
        for (let i = 0; i < buf.length; ++i) {
            buf[i] = view[i]
        }
        return buf;
    }
    /**
     * @returns {Promise<import('file-type').FileTypeResult | undefined>}
     */
    Uint8Array.prototype.getFileType =
        ArrayBuffer.prototype.getFileType =
        Buffer.prototype.getFileType = function getFileType() {
            return fileTypeFromBuffer(this)
        }
    /**
     * @returns {Boolean}
     */
    String.prototype.isNumber =
        Number.prototype.isNumber = function isNumber() {
            const int = parseInt(this)
            return typeof int === 'number' && !isNaN(int)
        }
    /**
     * @returns {String}
     */
    String.prototype.capitalize = function capitalize() {
        return this.charAt(0).toUpperCase() + this.slice(1, this.length)
    }
    /**
     * @returns {String}
     */
    String.prototype.sensorText = function sensorText() {
  var str = this.toString()
  var firstChar = str.charAt(0);
  var lastChar = str.charAt(str.length - 1);
  var middleChars = str.slice(1, -1);
  var regex = new RegExp("[a-zA-Z0-9]", "g");
  var hiddenText = middleChars.replace(regex, "*");
  var finalText = firstChar + hiddenText + lastChar;
return finalText;
    }
    /**
     * @returns {String}
     */
    String.prototype.capitalizeV2 = function capitalizeV2() {
        const str = this.split(' ')
        return str.map(v => v.capitalize()).join(' ')
    }
    /**
     * @returns {String}
     */
    String.prototype.decodeJid = function decodeJid() {
        if (/:\d+@/gi.test(this)) {
            const decode = jidDecode(this) || {}
            return (decode.user && decode.server && decode.user + '@' + decode.server || this).trim()
        } else return this.trim()
    }
    /**
     * Number must be milliseconds
     * @returns {string}
     */
    Number.prototype.toTimeString = function toTimeString() {
        // const milliseconds = this % 1000
        const seconds = Math.floor((this / 1000) % 60)
        const minutes = Math.floor((this / (60 * 1000)) % 60)
        const hours = Math.floor((this / (60 * 60 * 1000)) % 24)
        const days = Math.floor((this / (24 * 60 * 60 * 1000)))
        return (
            (days ? `${days} day(s) ` : '') +
            (hours ? `${hours} hour(s) ` : '') +
            (minutes ? `${minutes} minute(s) ` : '') +
            (seconds ? `${seconds} second(s)` : '')
        ).trim()
    }
    Number.prototype.toSimpleNumber = function toSimpleNumber() {
  let number = this.toString()
  let result = ''
  const suffixes = ["", "K", "M", "B", "T", "Qr", "Qt", "Sx"];
  let suffixIndex = 0;
  
  if (this >= 1000) {
  while (number >= 1000 && suffixIndex < suffixes.length - 1) {
    number /= 1000;
    suffixIndex++;
  }
  result = number.toFixed(2) + suffixes[suffixIndex];
  } else if(this < 1000) { result = number }
  
  return result
}
    Number.prototype.getRandom =
        String.prototype.getRandom =
        Array.prototype.getRandom = function getRandom() {
            if (Array.isArray(this) || this instanceof String) return this[Math.floor(Math.random() * this.length)]
            return Math.floor(Math.random() * this)
        }
}
/**
 * ??
 * @link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Nullish_coalescing_operator
 * @returns {boolean}
 */
function nullish(args) {
    return !(args !== null && args !== undefined)
}