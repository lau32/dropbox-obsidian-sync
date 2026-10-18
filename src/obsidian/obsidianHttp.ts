import { requestUrl } from 'obsidian';
import type { HttpClient, HttpRequest, HttpResponse } from '../remote/http';

export const obsidianHttp: HttpClient = async (
  req: HttpRequest,
): Promise<HttpResponse> => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });

  return {
    status: res.status,
    headers: res.headers,
    text: () => res.text,
    arrayBuffer: () => res.arrayBuffer,
  };
};
