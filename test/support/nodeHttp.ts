import { HttpClient, HttpRequest, HttpResponse } from '../../src/remote/http';
import { decodeText } from '../../src/bytes';

export const nodeHttp: HttpClient = async (req: HttpRequest): Promise<HttpResponse> => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  const buf = await res.arrayBuffer();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: res.status,
    headers,
    text: () => decodeText(buf),
    arrayBuffer: () => buf,
  };
};
