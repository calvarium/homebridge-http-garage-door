const http = require('http');
const https = require('https');
const { JSONPath } = require('jsonpath-plus');

class HttpClient {
    constructor(log, options = {}) {
        this.log = log;
        this.debug = options.debug;
        this.httpMethod = options.httpMethod || 'GET';
        this.timeout = options.timeout || 3000;
        this.auth = options.auth;
        this.rejectUnauthorized = options.rejectUnauthorized !== false;
    }

    request(url, body, method, callback) {
        const reqMethod = (method || this.httpMethod).toUpperCase();
        if (this.debug && this.log) {
            this.log('HTTP request -> method: %s, url: %s, body: %s', reqMethod, url, body);
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch {
            if (callback) {callback(new Error(`Invalid URL: ${url}`));}
            return;
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: reqMethod,
            timeout: this.timeout,
            rejectUnauthorized: isHttps ? this.rejectUnauthorized : undefined,
        };

        if (this.auth && this.auth.user && this.auth.pass) {
            options.auth = `${this.auth.user}:${this.auth.pass}`;
        }

        const bodyStr = body ? String(body) : '';
        if (bodyStr) {
            options.headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(bodyStr),
            };
        }

        const req = transport.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (callback) {callback(null, res, data);}
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Request timed out after ${this.timeout}ms`));
        });

        req.on('error', (err) => {
            if (this.debug && this.log) {
                this.log('HTTP request error: %s', err.message);
            }
            if (callback) {callback(err);}
        });

        if (bodyStr) {
            req.write(bodyStr);
        }
        req.end();
    }

    getStatus(url, statusKey, values, callback) {
        if (this.debug && this.log) {
            this.log('Getting status: %s', url);
        }
        this.request(url, '', 'GET', (error, response, responseBody) => {
            if (error) {
                callback(error);
                return;
            }
            let statusValue = 0;
            if (statusKey) {
                let parsed;
                try {
                    parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
                } catch (err) {
                    callback(new Error(`Failed to parse status response as JSON: ${err.message}`));
                    return;
                }
                const originalStatusValue = JSONPath({
                    path: statusKey,
                    json: parsed,
                    wrap: false,
                });
                if (new RegExp(values.open).test(originalStatusValue)) {
                    statusValue = 0;
                } else if (new RegExp(values.closed).test(originalStatusValue)) {
                    statusValue = 1;
                } else if (new RegExp(values.opening).test(originalStatusValue)) {
                    statusValue = 2;
                } else if (new RegExp(values.closing).test(originalStatusValue)) {
                    statusValue = 3;
                }
                if (this.debug && this.log) {
                    this.log('Transformed status value from %s to %s (%s)', originalStatusValue, statusValue, statusKey);
                }
            } else {
                statusValue = responseBody;
            }
            callback(null, statusValue);
        });
    }
}

module.exports = HttpClient;
