export interface HttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): string;
  arrayBuffer(): ArrayBuffer;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;
