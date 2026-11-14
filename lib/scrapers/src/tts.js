import axios from 'hiro/axios'

const endpoint = 'https://starlabs.biz.id/startts/proxy.php'

export const voices = [
    { nama: 'Bennett Cole - Natural Chat', bahasa: 'en-US', gender: 'male', voice_id: '250173c4-4548-4a66-9eb4-a980c2f601d7' },
    { nama: 'Miles - Bright Narrator', bahasa: 'en-US', gender: 'male', voice_id: 'e33966e0-949e-4e29-863e-c8cc7cd961ff' },
    { nama: 'Derek - Bold Action Voice', bahasa: 'en-US', gender: 'male', voice_id: '56b2624d-fea2-4ae2-9410-7d11e3695bdc' },
    { nama: 'Asher Lane - Dark Grit', bahasa: 'en-US', gender: 'male', voice_id: '87098563-0297-42b1-8ffc-48322073ceda' },
    { nama: 'Nadia Wells - Youthful Spark', bahasa: 'en-US', gender: 'female', voice_id: '35ca820f-b836-4419-a829-3cfdb714211e' },
    { nama: 'Maeve Harper - Expressive Energy', bahasa: 'en-US', gender: 'female', voice_id: '95ebe841-7e92-4361-aa87-167b5b3979b1' },
    { nama: 'Felix Carter - Expressive Voice', bahasa: 'en-US', gender: 'male', voice_id: 'cbe44fd9-c661-496a-8018-c40c013ad55b' },
    { nama: 'Anya Reed - Calm Meditation', bahasa: 'en-US', gender: 'female', voice_id: 'fcb2c362-4789-4938-94f6-c68f2ddd73dc' },
    { nama: 'Finn - Mischievous Character', bahasa: 'en-US', gender: 'male', voice_id: '3c9f2d9f-048e-4fed-9590-9b61f14d4a14' },
    { nama: 'Graham - Gentle Studio Man', bahasa: 'en-US', gender: 'male', voice_id: '90ed1a4e-fe7f-493e-965c-dc06e02760a8' },
    { nama: 'Pip - Playful Character', bahasa: 'en-US', gender: 'neutral', voice_id: '6ec5b6ac-30ff-4c6d-be95-c1be76ff7c08' },
    { nama: 'Dylan Marlow - Gentle Trust', bahasa: 'en-US', gender: 'male', voice_id: '449fa787-480c-4857-b249-d2640c7fc332' },
    { nama: 'Gemma Cole - Engaging Educator', bahasa: 'en-US', gender: 'female', voice_id: 'cbfef6aa-aeb9-4219-a6a1-2e7fedc6ec57' },
    { nama: 'Mason Clarke - Warm Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '13e7914d-ab0e-4149-bc05-69a41895ebfa' },
    { nama: 'Lydia Stone - Professional Guide', bahasa: 'en-US', gender: 'female', voice_id: 'ccbc80fc-39c0-406b-823e-5206c1db5bdc' },
    { nama: 'Isla Rowan - Audiobook Pro', bahasa: 'en-US', gender: 'female', voice_id: '804c1671-40a5-4709-ae1b-e865923f9de4' },
    { nama: 'Maren - Serene Narration', bahasa: 'en-US', gender: 'female', voice_id: '14b0a424-93aa-4b72-b5e7-33cccaeec09a' },
    { nama: 'Sienna Ford - Neutral Guide', bahasa: 'en-US', gender: 'female', voice_id: '2d8ff908-3438-4ede-ab0c-bac36bb06dcf' },
    { nama: 'Julian Cross - Relaxed Optimist', bahasa: 'en-US', gender: 'male', voice_id: 'db21c21d-3db0-4803-bade-4f84b06472be' },
    { nama: 'Elara Wynn - Warm Reflection', bahasa: 'en-US', gender: 'female', voice_id: 'c97ef63a-2488-49f6-92d4-a0f60ddd9b7e' },
    { nama: 'Tobias Wynn - Laid Back Resonance', bahasa: 'en-US', gender: 'male', voice_id: '00a01440-b3f2-4c7f-b919-53d9a79dc482' },
    { nama: 'Hugo Porter - Resonant Comfort', bahasa: 'en-US', gender: 'male', voice_id: '5ff07236-d221-4127-b5b9-bb4f597309c7' },
    { nama: 'Fiona Ash - Quirky Energy', bahasa: 'en-US', gender: 'female', voice_id: '6549443e-1de2-45d7-85ea-2d7ee3f9dff1' },
    { nama: 'Logan Frost - Broadcast Anchor', bahasa: 'en-US', gender: 'male', voice_id: 'd88039cd-4bde-4c85-b262-8750a5dff06d' },
    { nama: 'Elise - Charming Studio Voice', bahasa: 'en-US', gender: 'female', voice_id: '2e27b183-1700-4aab-8619-c3a3a7db3c28' },
    { nama: 'Clara Vale - Pro Voice', bahasa: 'en-US', gender: 'female', voice_id: 'a3b46b70-fb74-4e7b-8a3d-2b02eb5e2089' },
    { nama: 'Graham Pierce - Fierce Warrior', bahasa: 'en-US', gender: 'male', voice_id: 'ced9b140-58e2-4e4f-ae9f-7a8a693e3e7c' },
    { nama: 'Clara Bell - Holiday Host', bahasa: 'en-US', gender: 'neutral', voice_id: 'af503ab1-c1d8-43dc-9fbb-0448d0153f2c' },
    { nama: 'Vera Sloan - Bright Friendly', bahasa: 'en-US', gender: 'female', voice_id: 'b9b9c236-4a7e-4d5b-8073-a866d3f2cb11' },
    { nama: 'Selene Ward - Mysterious Mood', bahasa: 'en-US', gender: 'female', voice_id: '61dd7853-ebb7-44e9-81ad-782e4adb541e' },
    { nama: 'Elliot Nash - Energetic Clarity', bahasa: 'en-US', gender: 'male', voice_id: '93894c8b-70c0-4274-b4ff-f3b2e1f07503' },
    { nama: 'Wesley Ford - Firm Authority', bahasa: 'en-US', gender: 'male', voice_id: 'fea9dc07-d584-4a11-b3ec-926bcc0999df' },
    { nama: 'Miles Archer - Social Spark', bahasa: 'en-US', gender: 'male', voice_id: 'a6747141-36bf-454f-9594-1ec58ab4b168' },
    { nama: 'Mara Ellis - Clear Upbeat', bahasa: 'en-US', gender: 'female', voice_id: '054c7d26-3d98-4669-9e26-e31badadbea7' },
    { nama: 'Tessa Hart - Grounded Pro', bahasa: 'en-US', gender: 'female', voice_id: 'b7c52df0-7271-47ef-880a-036d78ee662d' },
    { nama: 'Olive Pierce - Social Bright', bahasa: 'en-US', gender: 'female', voice_id: '8f0d66fc-aa3d-432a-b242-a96e1ea26cfa' },
    { nama: 'Reid Sutton - Bold Husky', bahasa: 'en-US', gender: 'male', voice_id: '72a01b7f-d69d-45f8-b940-029ff6b3a23e' },
    { nama: 'Nora - Holiday Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '0f727e72-07b2-47ce-b030-caec6d06588c' },
    { nama: 'Holden Gray - Deep Energy', bahasa: 'en-US', gender: 'male', voice_id: 'f969ef25-8c40-4a4d-b60b-55daa0048632' },
    { nama: 'Cora Blake - Reassuring Voice', bahasa: 'en-US', gender: 'female', voice_id: '937fc4de-f958-4edf-9af7-e1efcc5c5c44' },
    { nama: 'Daphne Brooks - Eloquent Villain', bahasa: 'en-US', gender: 'female', voice_id: '039d2648-ce4f-441a-af43-2a816e8e27a8' },
    { nama: 'Calvin - Diligent Tutor', bahasa: 'en-US', gender: 'male', voice_id: 'c151308e-0c3a-4594-86eb-9ee5a61c8be0' },
    { nama: 'Nova Quill - Squeaky Cartoon', bahasa: 'en-US', gender: 'neutral', voice_id: 'e43e6aaa-f3f8-4665-937f-70aed9d585ee' },
    { nama: 'Ronan Blake - Husky Trickster', bahasa: 'en-US', gender: 'male', voice_id: '7d8d0141-12ce-4e36-ab98-e176eccf2fd7' },
    { nama: 'Noel - Gentle Voice', bahasa: 'en-US', gender: 'male', voice_id: 'b67eeddb-050e-430e-ac6a-f830eeb4affa' },
    { nama: 'Dorian Hale - Smooth Trust', bahasa: 'en-US', gender: 'male', voice_id: 'f2c20379-2cdb-4fc4-8e2d-b45656d992c3' },
    { nama: 'Sawyer Quinn - Smooth Depth', bahasa: 'en-US', gender: 'male', voice_id: '115fa464-f0ca-476d-90e9-79739a0c6557' },
    { nama: 'Silas Reed - Inspiring Clarity', bahasa: 'en-US', gender: 'male', voice_id: '098bc3b1-1d24-49b5-943a-5c4b21290acf' },
    { nama: 'Maisy - Sweet Young Voice', bahasa: 'en-US', gender: 'female', voice_id: '66d50678-80d2-48a3-9e6a-b5ae019cd09c' },
    { nama: 'Iris Camden - Warm Clear Voice', bahasa: 'en-US', gender: 'female', voice_id: '6a16ef5c-0dd4-4f4d-a875-35afa6404146' },
    { nama: 'Evelyn Rose - Graceful Narration', bahasa: 'en-US', gender: 'female', voice_id: '67775b37-9bd4-4023-afa4-499b479687b6' },
    { nama: 'Parker Hayes - Balanced Wisdom', bahasa: 'en-US', gender: 'male', voice_id: '973a341d-f0b9-4ed4-9f0b-e0c45a329bd0' },
    { nama: 'Orion Vale - Deep Shadow', bahasa: 'en-US', gender: 'neutral', voice_id: 'b9d11507-5fc4-4474-99f5-243b4d39734b' },
    { nama: 'Celia North - Bright Warmth', bahasa: 'en-US', gender: 'female', voice_id: '55336d23-b294-4d7d-83b5-c2f446a9c81a' },
    { nama: 'Owen Hart - Wise Host', bahasa: 'en-US', gender: 'male', voice_id: 'cc0f9a7c-c385-47e5-919f-7050e88d3f34' },
    { nama: 'Phoebe Lane - Bright Professional', bahasa: 'en-US', gender: 'female', voice_id: 'd7d4da58-c6e8-4169-8c7a-f4ed44286968' },
    { nama: 'Theo Grant - Studio Voice', bahasa: 'en-US', gender: 'male', voice_id: '3311f051-e70d-44c1-a53f-37b7e119e80d' },
    { nama: 'Opal Finch - Velvet Actress', bahasa: 'en-US', gender: 'female', voice_id: 'e482d7c9-15c6-4980-8b11-e7d7af7e8185' },
    { nama: 'Skye - Bright Young Voice', bahasa: 'en-US', gender: 'female', voice_id: '22531df0-6e68-43d8-b8f2-61cc311d3acc' },
    { nama: 'Hugh - Relaxed Aussie Voice', bahasa: 'en-US', gender: 'male', voice_id: '0028607d-3914-4393-a0f2-e1ab21d05371' },
    { nama: 'Evan Mercer - Casual Light', bahasa: 'en-US', gender: 'male', voice_id: 'f6a29718-f486-447d-9485-c90c2ca5b498' },
    { nama: 'Grant - Trustworthy Guide', bahasa: 'en-US', gender: 'male', voice_id: 'b615d4a2-6aed-4d0f-b77d-3c585853ed65' },
    { nama: 'Mira Caldwell - Crisp Voice', bahasa: 'en-US', gender: 'female', voice_id: '18238c9f-fc4e-49e3-9aab-b168f15053d7' },
    { nama: 'Caleb Stone - Grounded Charm', bahasa: 'en-US', gender: 'male', voice_id: 'd3e63990-1fea-4916-83a8-d75b78b705bb' },
    { nama: 'Nolan Brooks - Grounded Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '2881b1e1-9322-4e1b-9d9d-e10ec67f0569' },
    { nama: 'Aiden Brooks - Confident Voice', bahasa: 'en-US', gender: 'male', voice_id: 'dbba07d8-de99-41dd-ad99-134c7d5c7c2e' },
    { nama: 'Nora Vale - Upbeat Voice', bahasa: 'en-US', gender: 'female', voice_id: '38b7c7f8-112b-40bd-b7e2-05afb2125b54' },
    { nama: 'Ethan Cross - Calm Guide', bahasa: 'en-US', gender: 'male', voice_id: 'f713280c-0b22-4765-a92c-d040700d5e03' },
    { nama: 'Maya Sterling - Deep Narrator', bahasa: 'en-US', gender: 'male', voice_id: '2a59cad2-ce23-47ce-82e5-8bc7af411f4a' },
    { nama: 'Lucas Grey - Natural Voice', bahasa: 'en-US', gender: 'male', voice_id: 'ca683601-6fba-4b05-9d06-96493322c108' },
    { nama: 'Ivy Monroe - Deep Narrator', bahasa: 'en-US', gender: 'male', voice_id: 'a8b06589-c5d2-4003-b58e-d16e3a68afed' },
    { nama: 'Grant Ellis - Studio Professional', bahasa: 'en-US', gender: 'male', voice_id: 'c63c4362-1cbc-4e0e-a30a-23e40238d9a5' },
    { nama: 'Clara Sutton - Character Signal', bahasa: 'en-US', gender: 'male', voice_id: 'f997764f-7eb6-455c-b4be-9ce0cce4e2a8' },
    { nama: 'Rowan Pierce - Calm Guide', bahasa: 'en-US', gender: 'male', voice_id: '8e3c8b23-c86d-4846-b1e2-714d0fc12b98' },
    { nama: 'Elena Hart - Calm Guide', bahasa: 'en-US', gender: 'male', voice_id: '506cd3e7-a231-41dc-9b5c-25bdcd96f105' },
    { nama: 'Miles Donovan - Deep Narrator', bahasa: 'en-US', gender: 'male', voice_id: '39ab9b24-43fd-4d5c-a1af-3b1ddec1ae51' },
    { nama: 'Audrey Lane - Natural Voice', bahasa: 'en-US', gender: 'male', voice_id: 'f0acf423-fa97-457a-819e-9e5ebe40ab18' },
    { nama: 'Caleb Reed - Natural Voice', bahasa: 'en-US', gender: 'male', voice_id: '266d895c-56ca-4633-a8f6-7b77f8b3d596' },
    { nama: 'Sophie Arden - Dramatic Edge', bahasa: 'en-US', gender: 'male', voice_id: 'fc0d7b0b-e5e4-490e-97e3-f2b380d5c6ed' },
    { nama: 'Noah Bennett - Calm Guide', bahasa: 'en-US', gender: 'male', voice_id: 'ee5ac19f-431d-491a-abfe-c104d92cf4d7' },
    { nama: 'Lila Morgan - Natural Voice', bahasa: 'en-US', gender: 'male', voice_id: '33b57e16-f0b9-47ef-84d3-6d8cd57aae62' },
    { nama: 'Jasper Cole - Deep Narrator', bahasa: 'en-US', gender: 'male', voice_id: 'd6df79e3-c030-44bd-bb21-4d2c1b49eea8' },
    { nama: 'Ava Sinclair - Confident Voice', bahasa: 'en-US', gender: 'male', voice_id: '43912274-ac58-417e-982a-b5dacd4e900d' },
    { nama: 'Theo Mason - Deep Narrator', bahasa: 'en-US', gender: 'male', voice_id: '3a17fc53-1c2e-4d05-852f-078c44e276f3' },
    { nama: 'Grace Hollis - Deep Narrator', bahasa: 'en-US', gender: 'male', voice_id: '4bcd3a36-b33e-454f-aa65-3efd480258da' },
    { nama: 'Elliot Hayes - Calm Guide', bahasa: 'en-US', gender: 'male', voice_id: '5bdf0e5c-1e36-41d0-a081-f0dd06cdf95c' },
    { nama: 'Mara Quinn - Studio Professional', bahasa: 'en-US', gender: 'male', voice_id: '74b57fbb-f353-4ebb-9ae7-b12f31c4280a' },
    { nama: 'Owen Blake - Confident Voice', bahasa: 'en-US', gender: 'male', voice_id: '84508b35-81c6-42bb-a003-95e23c96944f' },
    { nama: 'Chloe Rowan - Mature Narrator', bahasa: 'en-US', gender: 'male', voice_id: 'eef86dd3-2c10-4e50-82e4-10e0ac82248c' },
    { nama: 'Felix Shaw - Natural Voice', bahasa: 'en-US', gender: 'male', voice_id: 'f67aa759-ef92-4dcb-b79a-d9e2a37d2226' },
    { nama: 'Isabel Stone - Mature Narrator', bahasa: 'en-US', gender: 'male', voice_id: '9cd48997-8f66-4d9a-a4c9-05549b4e4c86' },
    { nama: 'Graham Wilde - Confident Voice', bahasa: 'en-US', gender: 'male', voice_id: 'c72187cf-cb90-44fa-b5bc-d80ea075fb4a' },
    { nama: 'Luna Mercer - Calm Guide', bahasa: 'en-US', gender: 'male', voice_id: 'c0b4503c-e877-4b44-bcc0-66923958181d' },
    { nama: 'Reid Parker - Calm Guide', bahasa: 'en-US', gender: 'male', voice_id: '4cd78ca5-5fd9-4d7d-908f-5095470f5a02' },
    { nama: 'Amelia Ross - Mature Narrator', bahasa: 'en-US', gender: 'male', voice_id: 'eb52a9fe-8eb1-4f80-b84e-a4767b46a2ac' },
    { nama: 'Silas Ford - Upbeat Voice', bahasa: 'en-US', gender: 'male', voice_id: '67bb182d-9e24-4fd4-9ddc-d94dddb906e7' },
    { nama: 'Violet James - Natural Voice', bahasa: 'en-US', gender: 'male', voice_id: '6431d65c-7a47-400f-9d0b-15eb35731965' },
    { nama: 'Bennett Sloan - Natural Voice', bahasa: 'en-US', gender: 'male', voice_id: '665dac31-8f7d-427c-b71e-7fcacb3848a6' },
    { nama: 'Celia Wynn - Deep Narrator', bahasa: 'en-US', gender: 'male', voice_id: 'efb97153-f275-4962-aeeb-c3ea59f991be' },
    { nama: 'Dorian Chase - Natural Chat', bahasa: 'en-US', gender: 'female', voice_id: 'fd7d3e2d-4c59-4b00-9bc8-42c463dc9bf2' },
    { nama: 'Phoebe Grant - Warm Clarity', bahasa: 'en-US', gender: 'female', voice_id: '6be28b0e-7e4f-47a9-9398-ade054995bc6' },
    { nama: 'Logan Vale - Clear Presenter', bahasa: 'en-US', gender: 'female', voice_id: 'c2aaefc8-fd52-4e2b-9228-ee257f5ee1e5' },
    { nama: 'Elise Carter - Confident Voice', bahasa: 'en-US', gender: 'female', voice_id: 'f6532c88-f2ec-46a5-b1e1-ce55713cf2cd' },
    { nama: 'Wesley North - Confident Voice', bahasa: 'en-US', gender: 'male', voice_id: '80bb0145-667f-4610-bd20-cfdb1a146af6' },
    { nama: 'Iris Bell - Upbeat Voice', bahasa: 'en-US', gender: 'male', voice_id: '0c791d50-bb29-4922-9584-d78461cf602b' },
    { nama: 'Archer Flynn - Natural Voice', bahasa: 'en-US', gender: 'female', voice_id: '7a5b3bb9-255b-4256-bc7f-cb36aa9c3863' },
    { nama: 'Tessa Reed - Calm Guide', bahasa: 'en-US', gender: 'female', voice_id: 'e57dd905-00ab-43dd-baa0-0116142ecd5a' },
    { nama: 'Julian Hart - Natural Chat', bahasa: 'en-US', gender: 'male', voice_id: '2df3bf3d-7068-4253-b11d-7e71aea4c9c8' },
    { nama: 'Nadia Cole - Calm Guide', bahasa: 'en-US', gender: 'female', voice_id: '39cbde87-28d3-4182-836a-c8f50d4dae54' },
    { nama: 'Mason Brooks - Studio Professional', bahasa: 'en-US', gender: 'male', voice_id: '53db300d-1448-4fe6-ac35-a8dcf3d5ca34' },
    { nama: 'Skye Harper - Natural Chat', bahasa: 'en-US', gender: 'female', voice_id: 'b439cdce-b561-477d-bc52-74353c5a4f4c' },
    { nama: 'Ronan Pierce - Warm Clarity', bahasa: 'en-US', gender: 'male', voice_id: 'fb3ac619-c9cb-4a81-80f8-493b5334c1f5' },
    { nama: 'Olive Clarke - Natural Chat', bahasa: 'en-US', gender: 'male', voice_id: '08839697-a0e4-4861-8ffa-591f43a8f6b3' },
    { nama: 'Holden Nash - Deep Narrator', bahasa: 'en-US', gender: 'male', voice_id: '915ccee1-0178-44eb-8353-5b8f418dcef2' },
    { nama: 'Sienna Ward - Bright Character', bahasa: 'en-US', gender: 'female', voice_id: '3dd2f565-395b-42c8-a6b8-774ea08bc391' },
    { nama: 'Adrian Ashford - Raspy Podcast Host', bahasa: 'en-US', gender: 'male', voice_id: 'caec1301-501a-4b8d-aaea-48dcad14f2a4' },
    { nama: 'Abigail Ashford - Grounded Community Host', bahasa: 'en-US', gender: 'female', voice_id: 'a711e120-d33d-460c-8395-6f57255f6b08' },
    { nama: 'Arthur Ashford - Crisp Reflective Storyteller', bahasa: 'en-US', gender: 'male', voice_id: 'f68c788c-0f7d-4e54-a8cf-55d5eedf80b1' },
    { nama: 'Cedric Ashford - Velvety Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '004b66a0-2545-4643-ae59-c73889c22f51' },
    { nama: 'Cecilia Ashford - Sprightly Animated Sidekick', bahasa: 'en-US', gender: 'female', voice_id: '860bb4d7-92aa-430d-a9b1-2312517d4ba6' },
    { nama: 'Colin Ashford - Weathered Philosopher', bahasa: 'en-US', gender: 'male', voice_id: '61faa813-d9bc-4f1e-84de-db3a6ba275a3' },
    { nama: 'Diana Ashford - Velvety Community Storyteller', bahasa: 'en-US', gender: 'female', voice_id: '1b4a39df-d0ba-469a-bae3-6507aef17482' },
    { nama: 'Dominic Ashford - Velvety Sleep Narrator', bahasa: 'en-US', gender: 'male', voice_id: 'f1cd6c3c-b7c9-45c0-b845-9b7a70052c77' },
    { nama: 'Estelle Ashford - Breathy Whimsical Storyteller', bahasa: 'en-US', gender: 'female', voice_id: 'f491b82f-3b57-4f51-b0b6-b499960ffd14' },
    { nama: 'Edmund Ashford - Textured Tech Instructor', bahasa: 'en-US', gender: 'male', voice_id: '796fcaf5-a106-474f-8e95-1f6638991d26' },
    { nama: 'Felicity Ashford - Husky Reflective Storyteller', bahasa: 'en-US', gender: 'female', voice_id: '74f7ce37-b924-4e12-b74e-49efc03d7ea0' },
    { nama: 'Gavin Ashford - Husky Southern Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '9a8ada06-1460-4beb-bd63-9fb62238a09c' },
    { nama: 'Georgia Ashford - Deep Southern Storyteller', bahasa: 'en-US', gender: 'female', voice_id: '234d7374-3baf-4385-aefd-429b8059e972' },
    { nama: 'Hector Ashford - Gravelly Fantasy Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '09a27c41-d5d1-4db5-ad06-78e11b231117' },
    { nama: 'Helena Ashford - Bright Digital Explainer', bahasa: 'en-US', gender: 'female', voice_id: '29873965-1944-458c-8b6a-6f8bf65f3d24' },
    { nama: 'Imogen Ashford - Gravelly Storyteller', bahasa: 'en-US', gender: 'female', voice_id: '4d930efd-e5d3-4ce4-b7b3-eb4c09da33a0' },
    { nama: 'Josephine Ashford - Brisk Friendly Announcer', bahasa: 'en-US', gender: 'female', voice_id: '3a4e2350-cc5a-413e-b1cc-fff0446d5e5b' },
    { nama: 'Katherine Ashford - Whimsical Tale Storyteller', bahasa: 'en-US', gender: 'female', voice_id: 'f586b423-91ce-4fce-81e0-91d7a07d1496' },
    { nama: 'Patrick Ashford - Lively Storybook Tenor', bahasa: 'en-US', gender: 'male', voice_id: 'e9a50df4-940d-424a-8c15-763644500e83' },
    { nama: 'Marina Ashford - Husky Mindfulness Guide', bahasa: 'en-US', gender: 'female', voice_id: 'ef2181f2-b701-4a13-bd02-d9891751768a' },
    { nama: 'Quentin Ashford - Gravelly Character Performer', bahasa: 'en-US', gender: 'male', voice_id: '83846ea9-1027-41bf-ab1f-cfbe81c40faf' },
    { nama: 'Natalie Ashford - Warm Civic Anchor', bahasa: 'en-US', gender: 'female', voice_id: '5b46f04c-0992-4cac-b688-cac3fe6d6370' },
    { nama: 'Rupert Ashford - Hushed Bass Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '6f875d95-5c0a-428d-adc0-044d03ad867a' },
    { nama: 'Victor Ashford - Bright Textured Explainer', bahasa: 'en-US', gender: 'male', voice_id: '2955b92b-d002-4b41-b65c-a32905bbc2f5' },
    { nama: 'Sylvia Ashford - Husky Reflective Host', bahasa: 'en-US', gender: 'female', voice_id: '551eca4b-e090-4a7c-b9f5-8241fbae8da2' },
    { nama: 'Vincent Ashford - Gravelly Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '7816f578-46bc-48b7-87fc-6f666fef301d' },
    { nama: 'Theresa Ashford - Velvety Bedtime Storyteller', bahasa: 'en-US', gender: 'female', voice_id: 'f28090f4-226c-4b87-82d9-d925dd08ff5d' },
    { nama: 'Vivian Ashford - Bright Fairytale Teller', bahasa: 'en-US', gender: 'female', voice_id: '58295afe-1982-4af8-b39b-868791575c85' },
    { nama: 'Adrian Bancroft - Warm Workplace Mentor', bahasa: 'en-US', gender: 'male', voice_id: '0b859756-4c9d-4458-87ad-654085cbcc4a' },
    { nama: 'Arthur Bancroft - Eccentric Storybook Character', bahasa: 'en-US', gender: 'male', voice_id: 'b7043bcd-1102-489f-a1d6-a4f51ad1dcd1' },
    { nama: 'Beatrice Bancroft - Breathy Gentle Guide', bahasa: 'en-US', gender: 'female', voice_id: 'e194dc80-6da5-4381-a5be-71fc88dbad9e' },
    { nama: 'Cedric Bancroft - Velvet Bass Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '9ceef65f-2f7b-40cb-aa16-8444866f75a7' },
    { nama: 'Diana Bancroft - Gentle Bedtime Storyteller', bahasa: 'en-US', gender: 'female', voice_id: '5186f14c-151f-4559-9ed4-7c514a4a928b' },
    { nama: 'Dominic Bancroft - Gravelly Animated Mentor', bahasa: 'en-US', gender: 'male', voice_id: 'a4b55d91-3b6f-4543-8fe5-36770901b4aa' },
    { nama: 'Estelle Bancroft - Breathy Mindfulness Guide', bahasa: 'en-US', gender: 'female', voice_id: '761557b1-7da7-45b1-8af6-acf5b3e98505' },
    { nama: 'Edmund Bancroft - Husky Community Host', bahasa: 'en-US', gender: 'male', voice_id: '5942e484-88af-4f6b-bea7-faeadde770a8' },
    { nama: 'Georgia Bancroft - Velvety Meditative Host', bahasa: 'en-US', gender: 'female', voice_id: '07b2ca75-a404-48eb-a03c-696f6f98bc8c' },
    { nama: 'Hector Bancroft - Textured Theatrical Storyteller', bahasa: 'en-US', gender: 'male', voice_id: 'd5d85b59-fe84-4746-b352-7464a3625897' },
    { nama: 'Imogen Bancroft - Husky Executive Coach', bahasa: 'en-US', gender: 'female', voice_id: '1c7cb1a8-7dbf-428e-ac70-a87764941861' },
    { nama: 'Josephine Bancroft - Buoyant Wellness Host', bahasa: 'en-US', gender: 'female', voice_id: '023bec35-cb7e-4fac-af1b-e097a22860fa' },
    { nama: 'Katherine Bancroft - Soft Mindful Storyteller', bahasa: 'en-US', gender: 'female', voice_id: '3deeb9ef-a4e8-42ca-8e80-6c57f05d8579' },
    { nama: 'Oscar Bancroft - Crisp Mystery Narrator', bahasa: 'en-US', gender: 'male', voice_id: '01b9d81a-8a91-40f6-8840-31df5262a017' },
    { nama: 'Patrick Bancroft - Zippy Explainer Host', bahasa: 'en-US', gender: 'male', voice_id: '3ff15f48-3587-425b-aaac-a3e83387c9f6' },
    { nama: 'Natalie Bancroft - Velvety Meditation Guide', bahasa: 'en-US', gender: 'female', voice_id: '7b1e16f0-7d86-448d-8e5f-c884299c21c6' },
    { nama: 'Rupert Bancroft - Bright Radio Broadcaster', bahasa: 'en-US', gender: 'male', voice_id: '0a40e9a5-e887-49d5-ac43-b41d08acb172' },
    { nama: 'Tristan Bancroft - Soft Meditative Guide', bahasa: 'en-US', gender: 'male', voice_id: '69f58d15-b0e2-476e-98f9-30201825ea0a' },
    { nama: 'Victor Bancroft - Bright Animated Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '0bf14ef5-429c-4710-8256-f610bcb1203e' },
    { nama: 'Sylvia Bancroft - Warm Direct Advisor', bahasa: 'en-US', gender: 'female', voice_id: '02e0637e-c3cb-46dd-8eff-b1312cb53db6' },
    { nama: 'Theresa Bancroft - Bright Lifestyle Host', bahasa: 'en-US', gender: 'female', voice_id: '835521d8-594b-4d91-8df2-e09c7956b8f5' },
    { nama: 'Walter Bancroft - Reedy Civic Broadcaster', bahasa: 'en-US', gender: 'male', voice_id: 'e9a5f141-990e-4603-b0e9-d7a5cef03be5' },
    { nama: 'Xavier Bancroft - Craggy Gentle Storyteller', bahasa: 'en-US', gender: 'male', voice_id: '10a021c8-65c1-495b-9a9e-c1e3ac3d7ad0' },
    { nama: 'Willa Bancroft - Smoky Mystery Narrator', bahasa: 'en-US', gender: 'female', voice_id: 'face2abf-7363-482c-94e8-7c20276f454e' },
    { nama: 'Adrian Callahan - Whimsical Elder Mentor', bahasa: 'en-US', gender: 'male', voice_id: '0a36c038-7564-4054-ae92-1252055f1fbc' },
    { nama: 'Abigail Callahan - Serene Bedtime Narrator', bahasa: 'en-US', gender: 'female', voice_id: '4a0e6ce5-3a5b-468d-b0df-303eb79a9d2c' },
    { nama: 'Arthur Callahan - Bright Animated Character', bahasa: 'en-US', gender: 'male', voice_id: 'e06d643e-912b-4182-b2f8-09960ab336fa' },
    { nama: 'Cedric Callahan - Velvety Sleep Guide', bahasa: 'en-US', gender: 'male', voice_id: '6522616f-8da9-4a28-8c34-6cdf674d7bdc' },
    { nama: 'Colin Callahan - Gravelly Chronicler', bahasa: 'en-US', gender: 'male', voice_id: 'b16d60e9-cc13-42ab-8f9c-79c11a576771' },
    { nama: 'Dominic Callahan - Bright Upbeat Explainer', bahasa: 'en-US', gender: 'male', voice_id: '3ac8a645-c407-4bb7-abee-bca369bbd8d2' },
    { nama: 'Edmund Callahan - Raspy Fantasy Villain', bahasa: 'en-US', gender: 'male', voice_id: 'bcf2d6e6-7a75-4875-ad0e-d2c5e5d9f43a' },
    { nama: 'Felicity Callahan - Hushed Storyteller', bahasa: 'en-US', gender: 'female', voice_id: '5435fa3e-5aa9-4330-a57e-b090b4d66538' },
    { nama: 'Georgia Callahan - Husky Reflective Storyteller', bahasa: 'en-US', gender: 'female', voice_id: 'b241d684-3426-498f-8fab-f7cd0aa6b420' },
    { nama: 'Hector Callahan - Theatrical Raspy Storyteller', bahasa: 'en-US', gender: 'male', voice_id: 'f9fc053b-674c-419e-b2ce-7f15ddb682ec' },
    { nama: 'Helena Callahan - Smoky Deliberate Mentor', bahasa: 'en-US', gender: 'female', voice_id: 'd7a1328c-16ba-49d4-8885-4bd00dabdc46' }
]

const retryLimit = 4
const minRequestGap = 2000
const maxRetryDelay = 60000

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

let queue = Promise.resolve()
let lastRequestAt = 0

const enqueue = task => {
    const run = queue.then(async () => {
        const gap = lastRequestAt + minRequestGap - Date.now()
        if (gap > 0) await wait(gap)
        lastRequestAt = Date.now()
        return task()
    })
    queue = run.catch(() => {})
    return run
}

const rateLimitHeaders = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']

const describeFailure = error => {
    if (error.response) {
        const headers = error.response.headers || {}
        const details = rateLimitHeaders
            .filter(name => headers[name] !== undefined)
            .map(name => `${name}: ${headers[name]}`)
        const base = `HTTP ${error.response.status} ${error.response.statusText || ''}`.trim()
        return details.length ? `${base} (${details.join(', ')})` : base
    }
    return error.code ? `${error.code}: ${error.message}` : error.message
}

const retryAfterMs = error => {
    const seconds = Number(error.response?.headers?.['retry-after'])
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

const isRetryable = error => {
    const status = error.response?.status
    const retryAfter = retryAfterMs(error)
    if (retryAfter !== undefined && retryAfter > maxRetryDelay) return false
    return status === undefined || status >= 500 || status === 429
}

const retryDelayFor = (error, attempt) => {
    const retryAfter = retryAfterMs(error)
    if (retryAfter !== undefined) return retryAfter
    const base = error.response?.status === 429 ? 5000 : 2000
    return Math.min(base * 2 ** (attempt - 1), maxRetryDelay)
}

const requestAudio = async (text, voiceId) => {
    const response = await axios.post(
        endpoint,
        new URLSearchParams({
            action: 'generate',
            text,
            voice: voiceId,
            stream: '1',
            b64: '1'
        }).toString(),
        {
            responseType: 'arraybuffer',
            headers: {
                Accept: '*/*',
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: 'https://starlabs.biz.id',
                Referer: 'https://starlabs.biz.id/startts/id',
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
            },
            timeout: 60000
        }
    )
    const audio = Buffer.from(response.data)
    if (audio[0] === 0x7b) throw new Error('Unexpected JSON response instead of audio')
    return audio
}

export async function speak(text, voiceId) {
    for (let attempt = 1; attempt <= retryLimit; attempt++) {
        try {
            return await enqueue(() => requestAudio(text, voiceId))
        } catch (error) {
            const reason = describeFailure(error)
            if (!isRetryable(error) || attempt === retryLimit) {
                throw new Error(attempt > 1 ? `${reason} after ${attempt} attempts` : reason)
            }
            await wait(retryDelayFor(error, attempt))
        }
    }
}
