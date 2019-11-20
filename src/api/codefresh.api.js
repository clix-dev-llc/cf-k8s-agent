'use strict';

const _ = require('lodash');
const rp = require('request-promise');
const newRelicMonitor = require('cf-monitor');
const logger = require('../logger');
const config = require('../config');
const MetadataFilter = require('../filters/MetadataFilter');
const statistics = require('../statistics');
const storage = require('../storage');
const kubernetes = require('../kubernetes');

let metadataFilter;
let counter;

class CodefreshAPI {

    constructor() {
        this.lock = false;

        setInterval(this._sendPackage, 120 * 1000);
    }


    /**
     * Init cluster events in monitor. Should be used when agent starts.
     * Agent will send all resources when watching will start.
     * @param accounts - array of binded accounts
     * @returns {Promise<void>}
     */
    async initEvents(accounts = []) {
        const uri = '/init';
        logger.debug(`Before init events. ${uri}`);
        logger.debug(`Init events. Cluster: ${config.clusterId}. Account: ${config.accountId}`);

        return Promise.all([
            this.getMetadata(),
            this._request({ method: 'POST', uri, body: { accounts }}),
        ])
            .then(([metadata]) => {
                metadataFilter = new MetadataFilter(metadata);
                counter = 1;
                logger.debug(`Metadata -------: ${JSON.stringify(metadata)}`);
            });
    }

    getMetadataFilter() {
        return metadataFilter;
    }

    sendEventsWithLogger(...args) {
        return this.sendEvents(...args).catch((error) => {
            logger.error(error);
            newRelicMonitor.noticeError(error);
        });
    }

    async checkState(callback) {
        const uri = '/state';
        logger.debug(`Checking init events. ${uri}`);
        try {
            const result = await this._request({ uri });

            if (result.needRestart) {
                logger.info(`Agent exits by monitor command`);
                process.exit();
            }

            if (result.needUpdate) {
                callback();
            }
        } catch(error) {
            newRelicMonitor.noticeError(error);
            logger.error(`Error while checking state: ${error.message}`);
        }
    }

    _sendPackage() {
        if(this.lock) {
            logger.info('Cant send because of lock');
            return;
        }
        this.lock = true;
        const payload = storage.get();

        storage.clear();

        logger.info(`Sending package with ${payload.length} element(s).`);
        this._request({ method: 'POST', uri: '', body: payload })
            .then((r) => {
                logger.debug(`sending result: ${JSON.stringify(r)}`);
                statistics.incPackages();
            })
            .then(() => {
                this.lock = false;
            }).catch(e => {
                logger.error(`Cant send because ${e}`);
                storage.pushMany(payload);
                this.lock = false;
            });
    }

    sendPackageWithoutLock(payload) {
        logger.info(`Sending package with ${payload.length} element(s).`);
        this._request({ method: 'POST', uri: '', body: payload })
            .then((r) => {
                logger.debug(`sending result: ${JSON.stringify(r)}`);
                statistics.incPackages();
            });
    }
    clearInfo(payload) {
        this._request({ method: 'POST', uri: '/clear', body: payload });
    }

    async getMetadata() {
        const uri = '/metadata';
        logger.debug(`Get metadata from ${uri}.`);
        return this._request({ uri });
    }

    async sendStatistics() {
        const uri = '/statistics';
        const body = statistics.result;

        logger.debug(`Sending statistics. ${JSON.stringify(body)}`);
        return this._request({ method: 'POST', uri, body })
            .then(statistics.reset);
    }

    _getIdentifyOptions() {
        if (config.token) {
            return {
                headers: {
                    'authorization': config.token,
                },
                qs: {
                    clusterId: config.clusterId,
                },
            };
        }
        return {
            headers: {},
            qs: {
                accountId: config.accountId,
                clusterId: config.clusterId,
            },
        };
    }

    _request(options) {
        const identify = this._getIdentifyOptions();
        const headers = _.merge(identify.headers, options.headers);
        const qs = _.merge(identify.qs, options.qs);

        const uri = `${config.apiUrl}${options.uri}`;
        const opts = _.merge({ json: true }, options, { headers, qs, uri });
        return rp(opts)
            .catch((e) => {
                logger.error(`Request error: ${e.statusCode} - ${e.message}`);
                newRelicMonitor.noticeError(e);
                return Promise.reject(e);
            });
    }
}

module.exports = new CodefreshAPI();
