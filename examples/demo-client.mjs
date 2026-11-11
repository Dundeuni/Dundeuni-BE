/** FE에서 import 후 runDemo({ image, text, phoneNumber })로 실행. 각 기능 실패는 독립 반환. */
export function createDemoClient(baseUrl = 'http://localhost:3001/api', token) {
  async function request(path, init = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(body.message || `HTTP ${response.status}`),
        { status: response.status, body },
      );
    return body;
  }
  function upload(path, image, type) {
    const body = new FormData();
    if (type) body.append('type', type);
    body.append('file', image);
    return request(path, { method: 'POST', body });
  }
  const json = (path, body) =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    image: (file) => upload('/analysis', file, 'IMAGE'),
    text: (text) => json('/analysis', { type: 'TEXT', text }),
    phone: (phoneNumber) => json('/analyses/phone', { phoneNumber }),
    extract: (file) => upload('/analysis/image-uploads', file),
    select: (uploadId, elementId) =>
      json(`/analysis/image-uploads/${uploadId}/analyses`, { elementId }),
    cancel: (uploadId) =>
      request(`/analysis/image-uploads/${uploadId}`, { method: 'DELETE' }),
    history: () => request('/history'),
    detail: (id) => request(`/history/${id}`),
    async runDemo({ image, text, phoneNumber }) {
      const jobs = {
        image: () => this.image(image),
        text: () => this.text(text),
        phone: () => this.phone(phoneNumber),
        elements: () => this.extract(image),
      };
      const names = Object.keys(jobs);
      const results = await Promise.allSettled(names.map((key) => jobs[key]()));
      return {
        ...Object.fromEntries(names.map((key, i) => [key, results[i]])),
        history: await Promise.allSettled([this.history()]).then(
          ([result]) => result,
        ),
      };
    },
  };
}
