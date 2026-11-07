import axios from 'hiro/axios';

async function ssweb(url, type = 'desktop') {
  return new Promise((resolve, reject) => {
    const base = 'https://www.screenshotmachine.com';
    const param = { url, device: type === 'desktop' ? 'desktop' : type, cacheLimit: 0, 'full':true };
    axios({
      url: `${base}/capture.php`,
      method: 'POST',
      data: new URLSearchParams(Object.entries(param)),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    })
      .then((data) => {
        const cookies = data.headers['set-cookie'];
        if (data.data.status === 'success') {
          axios.get(`${base}/${data.data.link}`, {
            headers: { cookie: cookies.join('; ') },
            responseType: 'arraybuffer'
          })
            .then(({ data }) => {
              const result = { status: 200, result: data };
              resolve(result);
            })
            .catch(reject);
        } else {
          const fa = { status: 404, result: 'failed' };
          resolve(fa);
        }
      })
      .catch(reject);
  });
}

export { ssweb }
