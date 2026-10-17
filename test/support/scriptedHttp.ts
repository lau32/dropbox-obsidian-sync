import { HttpClient, HttpRequest, HttpResponse } from '../../src/remote/http';
import { encodeText, decodeText } from '../../src/bytes';

export interface ScriptedResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string | ArrayBuffer;
  throwError?: Error;
}

export type ScriptedItem =
  | ScriptedResponseSpec
  | Error
  | ((req: HttpRequest) => ScriptedResponseSpec | Promise<ScriptedResponseSpec>);

export interface ScriptedHttp {
  http: HttpClient;
  requests: HttpRequest[];
}

export function scriptedHttp(items: ScriptedItem[]): ScriptedHttp {
  const queue = [...items];
  const requests: HttpRequest[] = [];

  const http: HttpClient = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push({
      url: req.url,
      method: req.method,
      headers: { ...req.headers },
      body: req.body,
    });

    const next = queue.shift();
    if (!next) {
      throw new Error(`scriptedHttp: unexpected request to ${req.url} (queue empty)`);
    }

    if (next instanceof Error) {
      throw next;
    }

    const spec = typeof next === 'function' ? await next(req) : next;
    if (spec.throwError) {
      throw spec.throwError;
    }

    const status = spec.status ?? 200;
    const headers = { ...(spec.headers ?? {}) };

    let rawText: string;
    let rawBytes: ArrayBuffer;

    if (spec.json !== undefined) {
      rawText = JSON.stringify(spec.json);
      rawBytes = encodeText(rawText);
    } else if (typeof spec.body === 'string') {
      rawText = spec.body;
      rawBytes = encodeText(spec.body);
    } else if (spec.body instanceof ArrayBuffer) {
      rawBytes = spec.body;
      rawText = decodeText(spec.body);
    } else {
      rawText = '';
      rawBytes = new ArrayBuffer(0);
    }

    return {
      status,
      headers,
      text: () => rawText,
      arrayBuffer: () => rawBytes,
    };
  };

  return { http, requests };
}
