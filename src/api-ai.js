const lodash = require('lodash');
const apiai = require('apiai');
const rp = require('request-promise');

const sessionStore = require('./session')();
const log = require('./log');

let instance = null;

function getApiAiInstance() {
  if (!instance) {
    if (!lodash.has(process.env, 'APIAI_ACCESS_TOKEN')) {
      throw new Error('APIAI_ACCESS_TOKEN environment variable cannot be empty');
    }
    instance = apiai(process.env.APIAI_ACCESS_TOKEN);
  }
  return instance;
}

async function backchatApiAiSync(response, senderID) {
  if (process.env.BACKCHAT_APIAI_SYNC_URL) {
    const reqData = {
      url: process.env.BACKCHAT_APIAI_SYNC_URL,
      resolveWithFullResponse: true,
      method: 'POST',
      json: {
        sender_id: senderID,
        response
      }
    };
    try {
      const result = await rp(reqData);
      if (result.statusCode !== 200) {
        log.warn('Something wrong with BackChat endpoint', {
          module: 'botstack:api-ai'
        });
      } else {
        log.debug('Copy API.AI response to BackChat endpoint', {
          module: 'botstack:api-ai'
        });
      }
    } catch (e) {
      log.error(e, {
        module: 'botstack:api-ai'
      });
      throw e;
    }
  }
}

function processResponse(response, senderID) {
  if (lodash.get(response, 'result')) {
    log.debug('API.AI result', {
      module: 'botstack:api-ai',
      senderId: senderID,
      result: response.result
    });

    const responseData = lodash.get(response.result, 'fulfillment.data');
    const messages = lodash.get(response.result, 'fulfillment.messages');
    if (lodash.get(responseData, 'facebook')) {
      // FIXME: implement this type of messages
      log.debug('Response as formatted message', {
        module: 'botstack:api-ai',
        senderId: senderID
      });
      return null;
    } else if (!lodash.isEmpty(messages)) {
      const returnData = {
        messages,
        response
      };
      return returnData;
    }
    return null;
  }
  return null;
}

function getApiAiResponse({ apiAiRequest, senderID, eventName, message, sessionID } = {
  eventName: null, message: null
}) {
  return new Promise((resolve, reject) => {
    apiAiRequest.on('response', (response) => {
      const logParams = {
        module: 'botstack:api-ai',
        senderId: senderID,
        sessionId: sessionID,
        response
      };

      if (eventName) {
        logParams.eventName = eventName;
      }

      if (message) {
        logParams.message = message;
      }

      log.debug('API.AI responded', logParams);

      backchatApiAiSync(response, senderID);
      resolve(processResponse(response, senderID));
    });

    apiAiRequest.on('error', (error) => {
      log.debug(error, {
        module: 'botstack:api-ai',
        senderId: senderID
      });
      reject(error);
    });

    apiAiRequest.end();
  });
}

async function processEvent(eventName, senderID) {
  const sessionResult = await sessionStore.get(senderID);
  const sessionID = sessionResult.sessionID;

  log.debug('Process event', {
    module: 'botstack:api-ai',
    senderId: senderID,
    eventName,
    sessionId: sessionID
  });

  const apiAiService = getApiAiInstance();
  const apiAiRequest = apiAiService.eventRequest({
    name: eventName
  }, {
    sessionId: sessionID
  });

  const result = await getApiAiResponse({ apiAiRequest, senderID, eventName, sessionID });
  return result;
}

async function processTextMessage(message, senderID) {
  const sessionResult = await sessionStore.get(senderID);
  const sessionID = sessionResult.sessionID;

  log.debug('Process text message', {
    module: 'botstack:api-ai',
    senderId: senderID,
    message,
    sessionId: sessionID
  });

  const apiAiService = getApiAiInstance();
  const apiAiRequest = apiAiService.textRequest(message, {
    sessionId: sessionID
  });

  const result = await getApiAiResponse({ apiAiRequest, senderID, message, sessionID });
  return result;
}

module.exports = {
  processTextMessage,
  processEvent,
  processResponse
};
