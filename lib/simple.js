
import path from 'path'
import loadVoip from './voip/voip.js'
import https from 'https'
import db from './database.js'
import { toAudio, ZipFile as JSZip } from './converter.js'
import { parsePhoneNumber } from 'awesome-phonenumber'

function formatIntlNumber(number) {
    const pn = parsePhoneNumber('+' + number)
    return pn.valid ? pn.number.international : '+' + number
}
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

				key = `_LATEX_${latex_index++}`;
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

				key = `_HYPERLINK_${hyperlink_index++}`;
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

				key = `_CITATION_${citation_index - 1}`;
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
				jid: '@newsletter',
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
				provider: '',
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
			messageText: '[ CANNOT_LOAD_VIDEO ]',
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
			messageText: '[ CANNOT_LOAD_PRODUCT ]',
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
			messageText: '[ CANNOT_LOAD_POST ]',
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
			javascript: new Set(['break', 'case', 'catch', 'continue', 'debugger', 'delete', 'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'typeof', 'var', 'void', 'while', 'with', 'true', 'false', 'null', 'undefined', 'class', 'const', 'let', 'super', 'extends', 'export', 'import', 'yield', 'static', 'constructor', 'async', 'await', 'get', 'set']),

			typescript: new Set(['abstract', 'any', 'as', 'asserts', 'bigint', 'boolean', 'declare', 'enum', 'implements', 'infer', 'interface', 'is', 'keyof', 'module', 'namespace', 'never', 'readonly', 'require', 'number', 'object', 'override', 'private', 'protected', 'public', 'satisfies', 'string', 'symbol', 'type', 'unknown', 'using', 'from', 'break', 'case', 'catch', 'continue', 'do', 'else', 'finally', 'for', 'function', 'if', 'new', 'return', 'switch', 'this', 'throw', 'try', 'var', 'void', 'while', 'class', 'const', 'let', 'extends', 'import', 'export', 'async', 'await']),

			python: new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']),

			java: new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while']),

			golang: new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']),

			c: new Set(['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while']),

			cpp: new Set(['alignas', 'alignof', 'and', 'auto', 'bool', 'break', 'case', 'catch', 'class', 'const', 'constexpr', 'continue', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private', 'protected', 'public', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'while']),

			php: new Set(['abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone', 'const', 'continue', 'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if', 'implements', 'include', 'include_once', 'instanceof', 'interface', 'match', 'namespace', 'new', 'null', 'or', 'private', 'protected', 'public', 'require', 'require_once', 'return', 'static', 'switch', 'throw', 'trait', 'try', 'use', 'var', 'while', 'yield']),

			rust: new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while']),

			html: new Set(['html', 'head', 'body', 'div', 'span', 'p', 'a', 'img', 'video', 'audio', 'script', 'style', 'link', 'meta', 'form', 'input', 'button', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'section', 'article', 'header', 'footer', 'nav', 'main']),

			bash: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'in', 'select', 'until', 'break', 'continue', 'return', 'export', 'readonly', 'local', 'declare']),

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





export function HelperConnection(conn, { store, logger }) {
    const botUser = conn.user || {}

    

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

    
    
    
    
    
    
    
    if (optionTitle && optionText) {
        return built
    }

    
    return [{}, ...built]
}

function nfBuildMessageParams(buttons = [], { optionText, optionTitle, ltoText, ltoUrl, ltoCode, ltoExpiration } = {}) {
    const params = {}
    
    
    if (optionTitle || optionText) {
        
        
        const listTitle = String(optionText || optionTitle || 'Select')
        const buttonTitle = String(optionTitle || optionText || 'Select')
        
        
        
        
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




function nfNativeFlowAttrs(buttons = []) {
    
    
    
    
    
    
    
    
    return { name: 'mixed', v: '9' }
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

async function nfBuildHeader({ image, video, document, location, title = '', subtitle = '', mimetype, fileName, fileLength, jpegThumbnail } = {}) {
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
        if (typeof thumb === 'string') return thumb 
        return null
    }
    if (location) {
        const {
            buffer, image: locImage,
            latitude = 0, longitude = 0,
            name: locName = '', address = '', url: locUrl = ''
        } = typeof location === 'object' ? location : {}

        const rawSource = buffer ?? locImage
        let thumb = null
        if (rawSource) {
            const raw = typeof rawSource === 'string'
                ? Buffer.from(await (await fetch(rawSource)).arrayBuffer())
                : rawSource
            thumb = (await conn.resize(raw, 300, 300)).toString('base64')
        }

        return {
            title, subtitle, hasMediaAttachment: true,
            locationMessage: {
                degreesLatitude: latitude,
                degreesLongitude: longitude,
                name: locName,
                address,
                url: locUrl,
                ...(thumb && { jpegThumbnail: thumb })
            }
        }
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
        image, video, document, location,
        caption = '', text = '', body = '',
        footer = '',
        optionText, optionTitle,
        offerText, offerCode, offerUrl, offerExpiration,
        ltoText, ltoUrl, ltoCode, ltoExpiration,
        mimetype, fileName, fileLength, jpegThumbnail,
        mentions,
        nativeFlow = []
    } = opts

    const header = await nfBuildHeader({ image, video, document, location, mimetype, fileName, fileLength, jpegThumbnail })
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
    return !!(opts.nativeFlow || opts.cards || opts.image || opts.video || opts.document || opts.location || opts.caption || (opts.text && !opts.body && !opts.buttons))
}

    
    let sock = Object.defineProperties(conn, {
        decodeJid: {
            value(jid) {
                if (!jid || typeof jid !== 'string') return (!nullish(jid) && jid) || null
                jid = jid.trim()
                
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
            
            async value(PATH, saveToFile = false) {
                let res,
                    filename,
                    
                    data
                if (Buffer.isBuffer(PATH) || Helper.isReadableStream(PATH)) data = PATH
                
                else if (PATH instanceof ArrayBuffer) data = PATH.toBuffer()
                else if (/^data:.*?\/.*?;base64,/i.test(PATH)) data = Buffer.from(PATH.split`,`[1], 'base64')
                else if (/^https?:\/\//.test(PATH)) {
                    res = await fetch(PATH)
                    if (!res.ok) throw new Error(`Failed to fetch ${PATH}: ${res.status} ${res.statusText}`)
                    // res.body from global fetch (undici) is a WHATWG ReadableStream, not a
                    // Node.js stream — it has no .pipe()/.destroy(). Baileys expects a real
                    // Node Readable, so convert it here at the source.
                    data = Readable.fromWeb(res.body)
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
                const detected = await fileTypeStream(data)
                const streamWithType = detected || data
                const fileMime = detected?.fileType?.mime || 'application/octet-stream'
                const fileExt = detected?.fileType?.ext || 'bin'
                if (data && saveToFile && !filename) {
                    filename = path.join(`${process.cwd()}/data/tmp/${Date.now()}.${fileExt}`)
                    await Helper.saveStreamToFile(data, filename)
                }
                return {
                    res,
                    filename,
                    mime: fileMime,
                    ext: fileExt,
                    data: streamWithType,
                    async toBuffer() {
                        const buffers = []
                        for await (const chunk of streamWithType) buffers.push(chunk)
                        return Buffer.concat(buffers)
                    },
                    async clear() {
                        
                        streamWithType.destroy()
                        if (filename) await fs.promises.unlink(filename)
                    }
                }
            },
            enumerable: true,
            writable: true,
        },
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        sendFile: {
            
            async value(jid, path, filename = '', caption = '', quoted, ptt = false, options = {}) {
                const file = await conn.getFile(path)
                let mtype = '',
                    stream = file.data,
                    mimetype = options.mimetype || file.mime,
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
                let retryFile
                try {
                    return await conn.sendMessage(jid, message, { ...opt, ...options })
                } catch (e) {
                    console.error('sendFile: percobaan pertama gagal, mencoba ulang dengan stream baru (tanpa buffer penuh ke RAM):', e.message)
                    try {
                        // PENTING: jangan pakai toBuffer() di sini — itu akan membaca
                        // SELURUH file ke memori (Buffer.concat), bisa bikin OOM untuk
                        // file besar (video, dsb). Sebagai gantinya, buka ulang sumber
                        // aslinya (path/url) sebagai stream baru dan kirim ulang tetap
                        // sebagai stream.
                        retryFile = await conn.getFile(path)
                        let retryStream = retryFile.data
                        if (mtype === 'audio') {
                            const retryConvert = await toAudio(retryStream, retryFile.ext)
                            retryStream = retryConvert.data
                            convert = retryConvert
                        }
                        return await conn.sendMessage(jid, { ...message, [mtype]: { stream: retryStream } }, { ...opt, ...options })
                    } catch (e2) {
                        error = e2
                    }
                } finally {
                    file.clear()
                    if (retryFile) retryFile.clear()
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
        sendContact: {            
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
item1.TEL;waid=${number}:${formatIntlNumber(number)}
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
            
            let vcard = `
BEGIN:VCARD
VERSION:3.0
FN:${name.replace(/\n/g, '\\n')}
ORG:
item1.TEL;waid=${number}:${formatIntlNumber(number)}
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
        
        async value(jid, image, text, title, description, preview = 0, quoted, options = {}) {
            
            
            
            
            
            
            
            
            
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
        
        async value (jid, opts = {}, quoted, options) {
        
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
            try {
                await conn.relayMessage(jid, content, { messageId, additionalNodes, ...(options || {}) })
            } catch (e) {
                
                
                
                
                console.error('[sendButton:nativeFlow] relayMessage gagal:', e?.stack || e)
                console.error('[sendButton:nativeFlow] payload yang dikirim:', JSON.stringify(content, null, 2))
                throw new Error(`sendButton (native flow) gagal relayMessage: ${e?.message || e?.toString?.() || JSON.stringify(e) || 'unknown error (cek log server)'}`)
            }
            return { key: { remoteJid: jid, fromMe: true, id: messageId }, message: content }
        }

        
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
        
        value() {
            return new AIRich(conn)
        }
},

        cMod: {
            
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
            
            async value(m, type, opts) {
                let filename
                if (!m || !(m.url || m.directPath)) return Buffer.alloc(0)
                const stream = await downloadContentFromMessage(m, type)
                if (opts.asStream) {
                    
                    
                }
                
                let buffers = []
                for await (const chunk of stream) buffers.push(chunk)
                buffers = Buffer.concat(buffers)
                
                stream.destroy()
                
                if (opts.saveToFile) ({ filename } = await conn.getFile(buffers, true))
                return opts.saveToFile && fs.existsSync(filename) ? filename : buffers
            },
            enumerable: true,
            writable: true,
        },
        parseMention: {
            
            value(text = '') {
                return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(v => v[1] + '@s.whatsapp.net')
            },
            enumerable: true,
            writable: true,
        },
        getName: {
            
            value(jid = '', withoutContact = false) {
                jid = conn.decodeJid(jid)
                withoutContact = conn.withoutContact || withoutContact
                let v
                if (jid.endsWith('@g.us')) return (async () => {
                    v = await store.fetchGroupMetadata(jid, conn.groupMetadata) || {}
                    return (v.name || v.subject || formatIntlNumber(jid.replace('@s.whatsapp.net', '')))
                })()
                else v = jid === '0@s.whatsapp.net' ? {
                    jid,
                    vname: 'WhatsApp'
                } : areJidsSameUser(jid, conn.user?.id || '') ?
                    conn.user :
                    (store.getContact(jid) || {})
                return (withoutContact ? '' : v.name) || v.subject || v.vname || v.notify || v.verifiedName || formatIntlNumber(jid.replace('@s.whatsapp.net', ''))
            },
            enumerable: true,
            writable: true,
        },
        loadMessage: {
            
            value(jid, id) {
                if (!jid && !id) return null
                
                if (jid && !id) [id, jid] = [jid, null]
                return jid && id ? store.loadMessage(jid, id) : store.loadMessage(id)
            },
            enumerable: true,
            writable: true,
        },
        
        sendGroupV4Invite: {
            
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
    installSendStickerPack(sock)
    installConnCall(sock)

    return sock
}
















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


function isLidJid(jid) {
    return typeof jid === 'string' && decodeJid(jid)?.endsWith('@lid')
}


function isPhoneJid(jid) {
    return typeof jid === 'string' && decodeJid(jid)?.endsWith('@s.whatsapp.net')
}



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


export async function resolveLidToNumber(lidNumber, conn, chatId) {
    if (!lidNumber || !lidNumber.endsWith('@lid')) return null

    // Step 1: cara resmi di @whiskeysockets/baileys — lewat signalRepository.lidMapping.
    // conn.findUserId BUKAN API baileys (tidak ada di versi manapun), jadi jangan dipakai.
    try {
        const lidStore = conn?.signalRepository?.lidMapping
        if (typeof lidStore?.getPNForLID !== 'function') {
            console.warn(`[LID] signalRepository.lidMapping.getPNForLID tidak tersedia di versi baileys ini — skip step 1 (${lidNumber})`)
        } else {
            const pnResult = await lidStore.getPNForLID(lidNumber)
            const rawPn = typeof pnResult === 'string' ? pnResult : (pnResult?.pn || pnResult?.phoneNumber || null)
            if (rawPn) {
                const normalizedPn = rawPn.includes('@') ? rawPn : `${rawPn}@s.whatsapp.net`
                if (normalizedPn.endsWith('@s.whatsapp.net')) return normalizedPn
            }
            console.warn(`[LID] getPNForLID(${lidNumber}) tidak balikin PN valid:`, JSON.stringify(pnResult))
        }
    } catch (e) {
        console.warn(`[LID] getPNForLID(${lidNumber}) error:`, e.message)
    }

    // Fallback lama: kalau-kalau ada fork/wrapper yang nambahin conn.findUserId sendiri.
    try {
        if (typeof conn.findUserId === 'function') {
            const result = await conn.findUserId(lidNumber)
            const pn = result?.phoneNumber
            if (pn?.endsWith('@s.whatsapp.net')) return pn
            console.warn(`[LID] findUserId(${lidNumber}) tidak balikin phoneNumber valid:`, JSON.stringify(result))
        }
    } catch (e) {
        console.warn(`[LID] findUserId(${lidNumber}) error:`, e.message)
    }

    
    if (chatId?.endsWith('@g.us')) {
        const found = await resolveFromGroup(lidNumber, chatId, conn)
        if (found) return found
        console.warn(`[LID] Tidak ketemu di group metadata chat ${chatId} untuk ${lidNumber}`)
    }

    
    const fromAllGroups = await resolveFromAllGroups(lidNumber, conn)
    if (fromAllGroups) return fromAllGroups

    console.warn(`[LID] GAGAL resolve ${lidNumber} lewat semua metode (lidMapping, findUserId, group metadata chat ini, scan semua grup dikenal)`)
    return null
}


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
                
                if (this.chat?.endsWith('@newsletter')) {
                    const p = this.key?.participant || this.participant
                    if (!p || p === this.chat) {
                        return this.conn?.decodeJid(this.conn?.user?.id) || this.chat
                    }
                    return this.conn?.decodeJid(p) || p
                }
                
                if (this.key?.participantPn) {
                    return this.key.participantPn + '@s.whatsapp.net'
                }
                
                if (this.key?.senderPn) {
                    return this.key.senderPn + '@s.whatsapp.net'
                }
                const rawSender = this.conn?.decodeJid(
                    this.key?.fromMe && this.conn?.user.id ||
                    this.participant ||
                    this.key.participant ||
                    this.chat || ''
                )
                
                if (rawSender?.endsWith?.('@lid')) {
                    if (db.data?.users) {
                        
                        for (const [jid, u] of Object.entries(db.data.users)) {
                            if (jid.endsWith('@s.whatsapp.net') && u?.lid === rawSender) {
                                return jid
                            }
                        }
                        
                        const lidUser = db.data.users[rawSender]
                        if (lidUser?.number?.endsWith?.('@s.whatsapp.net')) {
                            return lidUser.number
                        }
                    }
                    
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
                            
                            if (contextInfo?.quotedParticipantPn) {
                                return contextInfo.quotedParticipantPn + '@s.whatsapp.net'
                            }
                            const raw = (contextInfo.participant || this.chat || '').decodeJid()
                            
                            
                            if (raw?.endsWith?.('@lid')) {
                                if (db.data?.users) {
                                    
                                    
                                    for (const [jid, u] of Object.entries(db.data.users)) {
                                        if (jid.endsWith('@s.whatsapp.net') && u?.lid === raw) {
                                            return jid
                                        }
                                    }
                                    
                                    
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
                        
                        value(text, chatId, options) {
                            return self.conn?.reply(chatId ? chatId : this.chat, text, this.vM, options)
                        },
                        enumerable: true,
                    },
                    copy: {
                        
                        value() {
                            const M = proto.WebMessageInfo
                            return smsg(conn, M.fromObject(M.toObject(this.vM)))
                        },
                        enumerable: true,
                    },
                    forward: {
                        
                        value(jid, force = false, options) {
                            return self.conn?.sendMessage(jid, {
                                forward: this.vM, force, ...options
                            }, { ...options })
                        },
                        enumerable: true,
                    },
                    copyNForward: {
                        
                        value(jid, forceForward = false, options) {
                            return self.conn?.copyNForward(jid, this.vM, forceForward, options)
                        },
                        enumerable: true,
                    },
                    cMod: {
                        
                        value(jid, text = '', sender = this.sender, options = {}) {
                            return self.conn?.cMod(jid, this.vM, text, sender, options)
                        },
                        enumerable: true,
                    },
                    delete: {
                        
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
    
    Buffer.prototype.toArrayBuffer = function toArrayBufferV2() {
        const ab = new ArrayBuffer(this.length)
        const view = new Uint8Array(ab)
        for (let i = 0; i < this.length; ++i) {
            view[i] = this[i]
        }
        return ab;
    }
    
    Buffer.prototype.toArrayBufferV2 = function toArrayBuffer() {
        return this.buffer.slice(this.byteOffset, this.byteOffset + this.byteLength)
    }
    
    ArrayBuffer.prototype.toBuffer = function toBuffer() {
        const buf = Buffer.alloc(this.byteLength)
        const view = new Uint8Array(this)
        for (let i = 0; i < buf.length; ++i) {
            buf[i] = view[i]
        }
        return buf;
    }
    
    Uint8Array.prototype.getFileType =
        ArrayBuffer.prototype.getFileType =
        Buffer.prototype.getFileType = function getFileType() {
            return fileTypeFromBuffer(this)
        }
    
    String.prototype.isNumber =
        Number.prototype.isNumber = function isNumber() {
            const int = parseInt(this)
            return typeof int === 'number' && !isNaN(int)
        }
    
    String.prototype.capitalize = function capitalize() {
        return this.charAt(0).toUpperCase() + this.slice(1, this.length)
    }
    
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
    
    String.prototype.capitalizeV2 = function capitalizeV2() {
        const str = this.split(' ')
        return str.map(v => v.capitalize()).join(' ')
    }
    
    String.prototype.decodeJid = function decodeJid() {
        if (/:\d+@/gi.test(this)) {
            const decode = jidDecode(this) || {}
            return (decode.user && decode.server && decode.user + '@' + decode.server || this).trim()
        } else return this.trim()
    }
    
    Number.prototype.toTimeString = function toTimeString() {
        
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

function nullish(args) {
    return !(args !== null && args !== undefined)
}

/* ============================================================
 * STICKER PACK FEATURE (conn.sendStickerPack)
 * ============================================================ */

function stickerSha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest()
}

function stickerToB64Url(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
}

function stickerIsWebP(buffer) {
    return buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
}

function stickerIsAnimatedWebP(buffer) {
    if (!stickerIsWebP(buffer)) return false

    let offset = 12

    while (offset < buffer.length - 8) {
        const chunk = buffer.toString('ascii', offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)

        if (chunk === 'VP8X' && (buffer[offset + 8] & 0x02)) return true
        if (chunk === 'ANIM' || chunk === 'ANMF') return true

        offset += 8 + size + (size % 2)
    }

    return false
}

function classifyStickerPackItem(buffer, stickerMessage) {
    if (stickerMessage?.isLottie) {
        return { ext: 'json', mimetype: 'application/json', isAnimated: true, isLottie: true }
    }

    return { ext: 'webp', mimetype: 'image/webp', isAnimated: stickerIsAnimatedWebP(buffer), isLottie: false }
}

/**
 * WhatsApp stickers MUST be WebP. If the input buffer is JPG/PNG/etc (e.g. a
 * profile picture or any regular image url), convert it to WebP first.
 * Lottie ('isLottie') stickers are left untouched since they're JSON, not image bytes.
 */
async function ensureStickerIsWebp(buffer, stickerMessage) {
    if (stickerMessage?.isLottie) return buffer
    if (stickerIsWebP(buffer)) return buffer

    const sharpMod = await import('sharp').catch(() => null)
    if (!sharpMod?.default) throw new Error('Install sharp dulu:\nnpm i sharp')

    return await sharpMod.default(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp()
        .toBuffer()
}

/**
 * Resolve a "content descriptor" like { url }, { buffer }, or a raw Buffer/string
 * into an actual Buffer. Supports: http(s) urls, local file paths, data: URIs, raw Buffer.
 */
async function resolveStickerToBuffer(input) {
    if (!input) throw new Error('Media kosong')

    if (Buffer.isBuffer(input)) return input

    if (typeof input === 'string') return resolveStickerToBuffer({ url: input })

    if (input.buffer && Buffer.isBuffer(input.buffer)) return input.buffer

    if (input.url) {
        const url = input.url

        if (typeof url !== 'string') throw new Error('url tidak valid')

        if (/^data:/i.test(url)) {
            const base64 = url.split(',')[1] ?? ''
            return Buffer.from(base64, 'base64')
        }

        if (/^https?:\/\//i.test(url)) {
            const res = await fetch(url)
            if (!res.ok) throw new Error(`Gagal fetch ${url}: ${res.status}`)
            return Buffer.from(await res.arrayBuffer())
        }

        // treat as local file path
        return await fs.promises.readFile(url)
    }

    throw new Error('Format media tidak dikenali (butuh url/buffer)')
}

async function makeStickerTrayWebp(buffer) {
    const sharpMod = await import('sharp').catch(() => null)
    if (!sharpMod?.default) throw new Error('Install sharp dulu:\nnpm i sharp')

    return await sharpMod.default(buffer, { animated: false })
        .resize(252, 252, { fit: 'cover' })
        .webp()
        .toBuffer()
}

async function makeBlankStickerTrayWebp() {
    const sharpMod = await import('sharp').catch(() => null)
    if (!sharpMod?.default) throw new Error('Install sharp dulu:\nnpm i sharp')

    return await sharpMod.default({
        create: {
            width: 252,
            height: 252,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .webp()
        .toBuffer()
}

async function makeStickerThumbnailJpeg(buffer) {
    const sharpMod = await import('sharp').catch(() => null)
    if (!sharpMod?.default) throw new Error('Install sharp dulu:\nnpm i sharp')

    return await sharpMod.default(buffer)
        .resize(252, 252, { fit: 'cover' })
        .jpeg()
        .toBuffer()
}

async function uploadStickerToServer(conn, buffer, { hkdf, mediaPath, mediaKey = crypto.randomBytes(32) }) {
    const expanded = Buffer.from(
        crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(hkdf), 112),
    )

    const iv = expanded.subarray(0, 16)
    const cipherKey = expanded.subarray(16, 48)
    const macKey = expanded.subarray(48, 80)

    const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()])

    const mac = crypto
        .createHmac('sha256', macKey)
        .update(iv)
        .update(encrypted)
        .digest()
        .subarray(0, 10)

    const encBuffer = Buffer.concat([encrypted, mac])

    const fileSha256 = stickerSha256(buffer)
    const fileEncSha256 = stickerSha256(encBuffer)

    const iq = await conn.query({
        tag: 'iq',
        attrs: {
            id: conn.generateMessageTag?.() ?? Date.now().toString(),
            to: 's.whatsapp.net',
            type: 'set',
            xmlns: 'w:m',
        },
        content: [{ tag: 'media_conn', attrs: {} }],
    })

    const mediaConn = iq.content?.find(v => v.tag === 'media_conn')
    if (!mediaConn) throw new Error('media_conn tidak ditemukan')

    const auth = mediaConn.attrs?.auth
    if (!auth) throw new Error('auth media_conn tidak ditemukan')

    const hosts = (mediaConn.content || [])
        .filter(v => v.tag === 'host')
        .map(v => v.attrs?.hostname)
        .filter(Boolean)

    if (!hosts.length) throw new Error('host upload tidak ditemukan')

    const token = encodeURIComponent(
        fileEncSha256.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    )

    let lastError

    for (const host of hosts) {
        try {
            const json = await new Promise((resolve, reject) => {
                const url = new URL(
                    `https://${host}${mediaPath}/${token}?auth=${encodeURIComponent(auth)}&token=${token}`,
                )

                const req = https.request(
                    {
                        hostname: url.hostname,
                        port: 443,
                        path: url.pathname + url.search,
                        method: 'POST',
                        headers: {
                            Origin: 'https://web.whatsapp.com',
                            Referer: 'https://web.whatsapp.com/',
                            'Content-Type': 'application/octet-stream',
                            'Content-Length': encBuffer.length,
                        },
                    },
                    (res) => {
                        let body = ''

                        res.on('data', c => body += c)

                        res.on('end', () => {
                            if (res.statusCode < 200 || res.statusCode >= 300) {
                                return reject(new Error(`Upload gagal ${res.statusCode}: ${body}`))
                            }

                            try {
                                resolve(JSON.parse(body))
                            } catch {
                                reject(new Error(`Response bukan JSON: ${body}`))
                            }
                        })
                    },
                )

                req.on('error', reject)
                req.write(encBuffer)
                req.end()
            })

            const directPath = json.direct_path ?? json.directPath ?? json.url ?? json.path
            if (!directPath) throw new Error('directPath tidak ditemukan')

            return {
                mediaKey,
                fileLength: buffer.length,
                fileSha256,
                fileEncSha256,
                directPath,
                ...json,
            }
        } catch (e) {
            lastError = e
        }
    }

    throw lastError ?? new Error('Semua host upload gagal')
}

/**
 * Core builder: takes a normalized list of { buffer, ext, mimetype, isAnimated, isLottie },
 * plus optional trayBuffer, and pack metadata. Uploads and returns the stickerPackMessage payload.
 */
async function buildStickerPackMessage(conn, items, { trayBuffer, name, publisher, description } = {}) {
    if (!items?.length) throw new Error('Pack tidak boleh kosong')

    const zip = new JSZip()
    const stickersMetadata = []

    for (const item of items) {
        const fileName = `${stickerToB64Url(stickerSha256(item.buffer))}.${item.ext}`

        zip.file(fileName, item.buffer)

        stickersMetadata.push({
            fileName,
            isAnimated: item.isAnimated,
            emojis: [''],
            accessibilityLabel: '',
            isLottie: item.isLottie,
            mimetype: item.mimetype,
        })
    }

    const trayIconFileName = 'tray_icon.webp'

    const resolvedTray = trayBuffer
        ? await makeStickerTrayWebp(trayBuffer)
        : (items.find(v => !v.isLottie)?.buffer
            ? await makeStickerTrayWebp(items.find(v => !v.isLottie).buffer)
            : await makeBlankStickerTrayWebp())

    zip.file(trayIconFileName, resolvedTray)

    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })

    const packUpload = await uploadStickerToServer(conn, archive, {
        hkdf: 'WhatsApp Sticker Pack Keys',
        mediaPath: '/mms/sticker-pack',
    })

    const thumbnailBuffer = await makeStickerThumbnailJpeg(resolvedTray)

    const thumbUpload = await uploadStickerToServer(conn, thumbnailBuffer, {
        hkdf: 'WhatsApp Sticker Pack Thumbnail Keys',
        mediaPath: '/mms/thumbnail-sticker-pack',
        mediaKey: packUpload.mediaKey,
    })

    return {
        messageContextInfo: {
            messageSecret: crypto.randomBytes(32),
        },
        stickerPackMessage: {
            stickerPackId: 'Pack_' + crypto.randomBytes(8).toString('hex'),
            name: name || 'Sticker Pack',
            publisher: publisher || '',
            packDescription: description || '',

            stickers: stickersMetadata,

            fileLength: packUpload.fileLength,
            fileSha256: packUpload.fileSha256,
            fileEncSha256: packUpload.fileEncSha256,
            mediaKey: packUpload.mediaKey,
            directPath: packUpload.directPath,
            mediaKeyTimestamp: Math.floor(Date.now() / 1000),
            stickerPackSize: packUpload.fileLength,
            stickerPackOrigin: 2,

            trayIconFileName,
            thumbnailDirectPath: thumbUpload.directPath,
            thumbnailSha256: thumbUpload.fileSha256,
            thumbnailEncSha256: thumbUpload.fileEncSha256,
            thumbnailHeight: 252,
            thumbnailWidth: 252,
            imageDataHash: thumbUpload.fileSha256.toString('base64'),
        },
    }
}

/**
 * Attaches conn.sendStickerPack(jid, options, quoted) to a connection object.
 *
 * Usage:
 * conn.sendStickerPack(jid, {
 *    cover: { url: './path/to/image.webp' },
 *    stickers: [
 *      { data: { url: './path/to/image.webp' } },
 *      { data: { url: './path/to/image2.webp' } },
 *    ],
 *    name: 'My Sticker Pack',
 *    publisher: 'Publisher stickerpack',
 *    description: 'Description pack'
 * }, m)
 */
export function installSendStickerPack(conn) {
    conn.sendStickerPack = async (jid, options = {}, quoted) => {
        const { cover, stickers, name, publisher, description } = options

        if (!stickers?.length) throw new Error('stickers tidak boleh kosong')

        const items = []

        for (const s of stickers) {
            const descriptor = s?.data ?? s
            let buffer = await resolveStickerToBuffer(descriptor)
            buffer = await ensureStickerIsWebp(buffer, s)
            const type = classifyStickerPackItem(buffer, s)
            items.push({ buffer, ...type })
        }

        const trayBuffer = cover ? await resolveStickerToBuffer(cover) : undefined

        const message = await buildStickerPackMessage(conn, items, {
            trayBuffer,
            name,
            publisher,
            description,
        })

        return conn.relayMessage(jid, message, quoted ? { quoted } : {})
    }

    return conn
}

// ─── VoIP call ────────────────────────────────────────────────────────────

let _voipSharedClient = null
let _voipConnecting = null
let _voipBusy = false

async function _voipGetClient(conn) {
    if (_voipSharedClient) return _voipSharedClient
    if (_voipConnecting) return _voipConnecting

    _voipConnecting = (async () => {
        const { VoipClient } = await loadVoip()
        const client = new VoipClient({ existingSocket: conn })
        await client.connect()
        _voipSharedClient = client
        return client
    })()

    try {
        return await _voipConnecting
    } finally {
        _voipConnecting = null
    }
}

// The underlying VoIP SDK never clears its private #activeCall after a call
// ends, so a cached VoipClient would permanently refuse subsequent calls.
// Force a full disconnect/reset after every call so the next conn.call()
// gets a fresh client with clean internal state.
function _voipResetClient() {
    if (_voipSharedClient) {
        try {
            _voipSharedClient.disconnect()
        } catch { }
    }
    _voipSharedClient = null
}

async function _voipGetAudioDurationMs(filePath) {
    try {
        const ffmpeg = (await import('fluent-ffmpeg')).default
        const durationSec = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) return reject(err)
                const duration = metadata?.format?.duration
                if (!duration || isNaN(duration)) return reject(new Error('Duration not found'))
                resolve(duration)
            })
        })
        return Math.ceil(durationSec * 1000)
    } catch {
        return null
    }
}

/**
 * Attaches conn.call(jid, audio) to a connection object — places an
 * outbound WhatsApp VoIP call playing the given audio file/URL.
 *
 * Usage:
 *   const call = await conn.call('62812xxxx@s.whatsapp.net', './path/to/audio.mp3')
 *   call.on('ringing', () => {})
 *   call.on('connected', () => {})
 *   call.on('ended', (reason) => {})
 *   call.on('error', (err) => {})
 *   ...
 *   await call.end() // hang up manually
 *
 * `audio` may be a local file path, a remote URL, or omitted/`'silence'` for
 * a silent call. Only one call may be active at a time (WhatsApp/the
 * underlying SDK only support a single active VoIP call per session).
 */
export function installConnCall(conn) {
    conn.call = async (jid, audio, opts = {}) => {
        if (_voipBusy) throw new Error('A call is already in progress, wait for it to finish.')

        const targetJid = String(jid || '').replace(/\D/g, '')
        if (!targetJid) throw new Error('Invalid phone number / jid.')

        let audioSource = 'silence'
        if (audio && audio !== 'silence') {
            if (/^https?:\/\//i.test(audio)) {
                const axios = (await import('axios')).default
                const response = await axios({
                    method: 'get',
                    url: audio,
                    responseType: 'arraybuffer',
                    timeout: 30_000,
                    maxContentLength: 20 * 1024 * 1024,
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                })
                const tmpDir = path.join(process.cwd(), process.env.TMP || 'data/tmp')
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
                audioSource = path.join(tmpDir, `voip_${Date.now()}.mp3`)
                fs.writeFileSync(audioSource, Buffer.from(response.data))
            } else {
                audioSource = audio
                if (!fs.existsSync(audioSource)) throw new Error(`Audio file not found: ${audioSource}`)
            }
        }

        _voipBusy = true
        const cleanup = () => {
            _voipBusy = false
            _voipResetClient()
        }

        try {
            const client = await _voipGetClient(conn)

            let durationMs = opts.durationMs
            if (durationMs == null && audioSource !== 'silence') {
                durationMs = await _voipGetAudioDurationMs(audioSource) || undefined
            }

            const call = await client.call(targetJid, { audioSource, ...(durationMs ? { durationMs } : {}) })

            call.once('ended', () => cleanup())
            call.once('error', () => cleanup())

            return call
        } catch (e) {
            cleanup()
            throw e
        }
    }

    return conn
}