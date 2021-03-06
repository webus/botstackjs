const fs = require('fs');
const path = require('path');
const lodash = require('lodash');
const restify = require('restify');
const rp = require('request-promise');

const fb = require('./fb');
const apiai = require('./api-ai');
const log = require('./log');
const smooch = require('./smooch');
const environments = require('./environments');
const settings = require('./settings');

/*
process.on('unhandledRejection', (reason, p) => {
    // console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.log(`Caught exception: ${err}`);
});
*/

const sessionStore = require('./session')();
const state = require('./state')();
const db = require('./dynamodb');
const s3 = require('./s3');

const { BotStackEmitterInit, BotStackCheck, BotStackEvents } = require('./events');

class BotStack {

  constructor(botName = 'default bot') {
    this.botName = botName;
    this.server = restify.createServer();

        // utils
    this.fb = fb;
    this.apiai = apiai;
    this.s3 = s3;
    this.log = log;

    settings.parseConfig(this);
    environments.checkEnvironmentVariables();
    environments.processEnvironmentVariables(this);

    this.server.use(restify.queryParser());
    this.server.use(restify.bodyParser());

    this.events = BotStackEmitterInit;
    this.state = state;

    this.server.get('/', (req, res, next) => {
      res.send('Nothing to see here...');
      return next();
    });

    this.server.get('/webhook/', (req, res, next) => {
      const token = req.query.hub.verify_token;
      if (token === process.env.FB_VERIFY_TOKEN) {
        res.write(req.query.hub.challenge);
        res.end();
      } else {
        res.send('Error, wrong validation token');
      }
      return next();
    });

    this.server.post('/webhook/', this._webhookPost(this)); // eslint-disable-line no-underscore-dangle

    this.server.post('/smooch/webhook/', this._smoochWebhook(this)); // eslint-disable-line no-underscore-dangle

    this.server.post('/apiaidb/', function (req, res, next) {
      res.json({
        speech: req.body.result.fulfillment.speech,
        displayText: req.body.result.fulfillment.speech,
        source: this.botName
      });
      res.end();
      log.debug('Received a database hook from API.AI', {
        module: 'botstack:apiaidb'
      });
      // add to db
      if (req.body) {
        db.logApiaiObject(req.body);
      } else {
        log.debug('No body to put in DB', {
          module: 'botstack:apiaidb'
        });
      }
      return next();
    });
  }

  /* eslint-disable no-unused-vars */
  subscription(message) {
    this.log.debug('Subscription method not implemented', {
      module: 'botstack:subscription'
    });
  }
  /* eslint-enable no-unused-vars */

  async geoLocationMessage(message, senderID) {
    this.log.debug('Process GEO location message', {
      module: 'botstack:geoLocationMessage',
      senderId: senderID,
      message
    });
    if (BotStackCheck('geoLocationMessage')) {
      BotStackEvents.emit('geoLocationMessage', {
        senderID,
        message
      });
    }
  }

  async textMessage(message, senderID, dontUseEvents = false) {
    const text = message.message.text;
    // botmetrics.logUserRequest(text, senderID);
    this.log.debug('Process text message', {
      module: 'botstack:textMessage',
      senderId: senderID,
      message
    });
    if (!dontUseEvents) {
      if (BotStackCheck('textMessage')) {
        BotStackEvents.emit('textMessage', {
          senderID,
          message
        });
        return;
      }
    }
    this.log.debug('Sending to API.AI', {
      module: 'botstack:textMessage',
      senderId: senderID,
      text
    });
    try {
      const apiaiResp = await apiai.processTextMessage(text, senderID);
      await fb.processMessagesFromApiAi(apiaiResp, senderID);
            // botmetrics.logServerResponse(apiaiResp, senderID);
    } catch (err) {
      await fb.reply(fb.textMessage("I'm sorry, I didn't understand that"), senderID);
      log.error(err, {
        module: 'botstack:textMessage',
        senderId: senderID,
        reason: 'Error on API.AI request'
      });
            // botmetrics.logServerResponse(err, senderID);
    }
  }

  _smoochWebhook(context) {
    this.log.debug('Smooch API endpoint ready', {
      module: 'botstack:smoochWebhook'
    });
    const self = context;
    return async function (req, res, next) { // eslint-disable-line func-names, no-unused-vars
      res.end();
      /* eslint-disable no-restricted-syntax, no-continue, no-await-in-loop */
      for (const msg of lodash.get(req.body, 'messages', [])) {
        // message schema
        // https://docs.smooch.io/rest/?javascript#schema44
        if (msg.role !== 'appUser') {
          continue;
        }
        self.log.debug('New message from Smooch endpoint', {
          module: 'botstack:smoochWebhook',
          message: msg
        });
        const text = lodash.get(msg, 'text');
        const authorID = lodash.get(msg, 'authorId');
        let apiAiResponse = null;
        let result = null;
        try {
          apiAiResponse = await self.apiai.processTextMessage(text, authorID);
          result = await smooch.processMessagesFromApiAi(apiAiResponse, authorID);
          self.log.debug('Smooch API result', {
            module: 'botstack:smoochWebhook',
            result
          });
        } catch (err) {
          self.log.error(err, {
            module: 'botstack:smoochWebhook'
          });
        }
      }
      /* eslint-enable no-restricted-syntax, no-continue */
    };
  }

  async _syncFbMessageToBackChat(req) {
    if (process.env.BACKCHAT_FB_SYNC_URL) {
      const reqData = {
        url: process.env.BACKCHAT_FB_SYNC_URL,
        resolveWithFullResponse: true,
        method: 'POST',
        json: req.body
      };
      let result = null;
      try {
        result = await rp(reqData);
        if (result.statusCode !== 200) {
          this.log.warn('Something wrong with BackChat endpoint', {
            module: 'botstack'
          });
        } else {
          this.log.debug('Copy FB response to BackChat endpoint', {
            module: 'botstack'
          });
        }
      } catch (err) {
        this.log.error(err, {
          module: 'botstack'
        });
        throw err;
      }
    }
  }

  /* eslint-disable class-methods-use-this, func-names, no-restricted-syntax */
  _webhookPost(context) {
    const self = context;
    return async function (req, res, next) { // eslint-disable-line no-unused-vars
      res.end();
      await self._syncFbMessageToBackChat(req); // eslint-disable-line no-underscore-dangle
      const entries = req.body.entry;
      for (const entry of entries) {
        const messages = entry.messaging;
        for (const message of messages) {
          const senderID = message.sender.id;
          const isEcho = !!lodash.get(message, 'message.is_echo');
          if (isEcho) {
            continue; // eslint-disable-line no-continue
          }
          log.debug('New Facebook message', {
            module: 'botstack:webhookPost',
            message
          });
          const isNewSession = await sessionStore.checkExists(senderID);
          const isPostbackMessage = !!message.postback;
          const isQuickReplyPayload = !!lodash.get(message, 'message.quick_reply.payload');
          const isTextMessage = !!(!isQuickReplyPayload && lodash.get(message, 'message.text'));
          const isGeoLocationMessage = !!lodash.get(message, 'message.attachments[0].payload.coordinates');
          log.debug('Detect kind of message', {
            module: 'botstack:webhookPost',
            senderID,
            isNewSession,
            isPostbackMessage,
            isQuickReplyPayload,
            isTextMessage,
            isGeoLocationMessage
          });
          await sessionStore.set(senderID);
          if (isQuickReplyPayload) {
            await self.quickReplyPayload(message, senderID);
          } else if (isGeoLocationMessage) {
            await self.geoLocationMessage(message, senderID);
          } else if (isTextMessage) {
            if (message.message.text === 'Get Started') {
              await self.welcomeMessage(message.message.text, senderID);
            } else {
              await self.textMessage(message, senderID);
            }
          } else if (isPostbackMessage) {
            if (message.postback.payload === 'Get Started') {
              await self.welcomeMessage(message.postback.payload, senderID);
            } else {
              await self.postbackMessage(message, senderID);
            }
          } else {
            await self.fallback(message, senderID);
          }
        }
      }
    };
  }
  /* eslint-enable class-methods-use-this, func-names */

  async welcomeMessage(messageText, senderID) {
    // botmetrics.logUserRequest(messageText, senderID);
    this.log.debug('Process welcome message', {
      module: 'botstack:welcomeMessage',
      senderId: senderID
    });
    if (BotStackCheck('welcomeMessage')) {
      BotStackEvents.emit('welcomeMessage', {
        senderID,
        messageText
      });
      return;
    }
    try {
      const apiaiResp = await apiai.processEvent('FACEBOOK_WELCOME', senderID);
      this.log.debug('Facebook welcome result', {
        module: 'botstack:welcomeMessage',
        senderId: senderID
      });
      await fb.processMessagesFromApiAi(apiaiResp, senderID);
      // botmetrics.logServerResponse(apiaiResp, senderID);
    } catch (err) {
      this.log.error(err, {
        module: 'botstack:welcomeMessage',
        senderId: senderID,
        reason: 'Error in API.AI response'
      });
      await fb.reply(fb.textMessage("I'm sorry, I didn't understand that"), senderID);
      // botmetrics.logServerResponse(err, senderID);
    }
  }

  async postbackMessage(postback, senderID) {
    const text = postback.postback.payload;
    this.log.debug('Process postback', {
      module: 'botstack:postbackMessage',
      senderId: senderID,
      postback,
      text
    });
        // botmetrics.logUserRequest(text, senderID);
    if (BotStackCheck('postbackMessage')) {
      BotStackEvents.emit('postbackMessage', {
        senderID,
        postback
      });
      return;
    }
    this.log.debug('Sending to API.AI', {
      module: 'botstack:postbackMessage',
      senderId: senderID,
      text
    });
    try {
      const apiaiResp = await apiai.processTextMessage(text, senderID);
      await fb.processMessagesFromApiAi(apiaiResp, senderID);
      // botmetrics.logServerResponse(apiaiResp, senderID);
    } catch (err) {
      this.log.error(err, {
        module: 'botstack:postbackMessage',
        senderId: senderID,
        reason: 'Error in API.AI response'
      });
      await fb.reply(fb.textMessage("I'm sorry, I didn't understand that"), senderID);
      // botmetrics.logServerResponse(err, senderID);
    }
  }

  async quickReplyPayload(message, senderID) {
    const text = lodash.get(message, 'message.quick_reply.payload');
    this.log.debug('Process quick reply payload', {
      module: 'botstack: quickReplyPayload',
      senderId: senderID,
      text
    });
        // botmetrics.logUserRequest(text, senderID);
    if (BotStackCheck('quickReplyPayload')) {
      BotStackEvents.emit('quickReplyPayload', {
        senderID,
        text,
        message
      });
      return;
    }
    this.log.debug('Sending to API.AI', {
      module: 'botstack:quickReplyPayload',
      senderId: senderID,
      text
    });
    try {
      const apiaiResp = await apiai.processTextMessage(text, senderID);
      await fb.processMessagesFromApiAi(apiaiResp, senderID);
      // botmetrics.logServerResponse(apiaiResp, senderID);
    } catch (err) {
      this.log.error(err, {
        module: 'botstack:quickReplyPayload',
        senderId: senderID,
        reason: 'Error in API.AI response'
      });
      await fb.reply(fb.textMessage("I'm sorry, I didn't understand that"), senderID);
      // botmetrics.logServerResponse(err, senderID);
    }
  }

  async fallback(message, senderID) {
    this.log.debug('Unknown message', {
      module: 'botstack:fallback',
      senderId: senderID,
      message
    });
  }

  startServer() {
    const port = process.env.PORT || 1337;
    const self = this;
    this.server.listen(port, () => {
      self.log.info(`Bot '${self.botName}' is ready`, {
        module: 'botstack'
      });
      self.log.info(`listening on port:${port} ${self.server.name} ${self.server.url}`, {
        module: 'botstack'
      });
    });
  }
}

module.exports = BotStack;
