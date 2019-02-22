import SCWorker from "socketcluster/scworker";
import { SocketErrors } from "./constants";
import { validateHeaders } from "./plugins/validate-headers";

class Worker extends SCWorker {
    public run() {
        console.log(`   >> Worker PID: ${process.pid}`);

        const scServer = (this as any).scServer;
        const self = this;

        scServer.on("connection", socket => {
            self.registerEndpoints(socket);
        });

        scServer.addMiddleware(scServer.MIDDLEWARE_EMIT, (req, next) => this.middleware(req, next));
    }

    public async registerEndpoints(socket) {
        const self = this;

        const handlers: any = await this.sendToMasterAsync({
            endpoint: "p2p.utils.getHandlers",
        });

        for (const name of handlers.peer) {
            socket.on(`p2p.peer.${name}`, async (data, res) =>
                self.forwardToMaster(Object.assign(data, { endpoint: `p2p.peer.${name}` }), res),
            );
        }

        for (const name of handlers.internal) {
            socket.on(`p2p.internal.${name}`, async (data, res) =>
                self.forwardToMaster(Object.assign(data, { endpoint: `p2p.internal.${name}` }), res),
            );
        }
    }

    public async middleware(req, next) {
        const createError = (name, message) => {
            const err = new Error(message);
            err.name = name;
            return err;
        };

        // only allow requests with data and headers specified
        console.log(`Received message from ${req.socket.remoteAddress} : ${JSON.stringify(req.data, null, 2)}`);
        if (!req.data || !req.data.headers) {
            return next(createError(SocketErrors.HeadersRequired, "Request data and data.headers is mandatory"));
        }

        try {
            const [prefix, version, method] = req.event.split(".");
            if (prefix !== "p2p") {
                return next(createError(SocketErrors.WrongEndpoint, `Wrong endpoint : ${req.event}`));
            }

            // Validate headers
            const headersValidation = validateHeaders(req.data.headers);
            if (!headersValidation.valid) {
                return next(
                    createError(
                        SocketErrors.HeadersValidationFailed,
                        `Headers validation failed: ${headersValidation.errors.map(e => e.message).join()}`,
                    ),
                );
            }

            // Check that blockchain, tx-pool and monitor gard are ready
            const isAppReady = await this.sendToMasterAsync({
                endpoint: "p2p.utils.isAppReady",
            });
            for (const [plugin, ready] of Object.entries(isAppReady)) {
                if (!ready) {
                    return next(
                        createError(SocketErrors.AppNotReady, `Application is not ready : ${plugin} is not ready`),
                    );
                }
            }

            if (version === "internal") {
                // Only allow internal to whitelisted (remoteAccess) peer / forger
                const isForgerAuthorized = await this.sendToMasterAsync({
                    endpoint: "p2p.utils.isForgerAuthorized",
                    data: { ip: req.socket.remoteAddress },
                });
                if (!isForgerAuthorized) {
                    return next(
                        createError(
                            SocketErrors.ForgerNotAuthorized,
                            "Not authorized: internal endpoint is only available for whitelisted forger",
                        ),
                    );
                }
            } else if (version === "peer") {
                // here is where we can acceptNewPeer()
                await this.sendToMasterAsync({
                    endpoint: "p2p.peer.acceptNewPeer",
                    data: { ip: req.socket.remoteAddress },
                    headers: req.data.headers,
                });
            }

            // some handlers need this remoteAddress info
            // req.data is socketcluster request data, which corresponds to our own "request" object
            // which is like this { endpoint, data, headers }
            req.data.headers.remoteAddress = req.socket.remoteAddress;
        } catch (e) {
            // Log explicit error, return unknown error
            console.error(e);
            return next(createError(SocketErrors.Unknown, "Unknown error"));
        }
        next(); // Allow
    }

    public async sendToMasterAsync(data) {
        const self: any = this;
        return new Promise((resolve, reject) => {
            self.sendToMaster(data, (err, val) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(val);
                }
            });
        });
    }

    public async forwardToMaster(data, res) {
        try {
            const masterResponse = await this.sendToMasterAsync(data);
            console.log(`Sending response: ${JSON.stringify(masterResponse, null, 2)}`);
            return res(null, masterResponse);
        } catch (e) {
            return res(e);
        }
    }
}

// tslint:disable-next-line
new Worker();