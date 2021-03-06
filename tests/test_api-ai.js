const lodash = require('lodash');
const rewire = require('rewire');

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

chai.use(chaiAsPromised);

const assert = chai.assert;
const expect = chai.expect;

const EventEmitter = require('events');

class TestEmitter extends EventEmitter {
  end() {
    console.log('End called');
  }
}

process.env.APIAI_ACCESS_TOKEN = 'demo_access_token';
const apiai = rewire('../src/api-ai');

const demoResponse = {
  result: {
    fulfillment: {
      messages: [
        {
          type: 0,
          speech: 'Hello ?'
        }
      ]
    }
  }
};

describe('Testing API.AI', () => {
  let revert = null;

  beforeEach(() => {
    revert = null;
  });

  afterEach(() => {
    if (revert) {
      revert();
      revert = null;
    }
  });

  it('Test processEvent using getApiAiResponse', async () => {
    revert = apiai.__set__('getApiAiResponse', async () => demoResponse);

    const response = await apiai.processEvent('demo', 'test_sender_id');
    assert.isOk(lodash.get(response, 'result.fulfillment.messages'));
  });

  it('Test processEvent with eventRequest', async () => {
    revert = apiai.__set__('getApiAiInstance', () => ({
      eventRequest: () => {
        const testEmitter = new TestEmitter();
        setTimeout(() => {
          testEmitter.emit('response', demoResponse);
        }, 30);
        return testEmitter;
      }
    }));
    const response = await apiai.processEvent('demo', 'test_sender_id');
    assert.isOk(lodash.get(response, 'messages'));
    assert.isTrue(lodash.get(lodash.find(response.messages, 'speech'), 'speech') === 'Hello ?');
  });

  it('Test processEvent with eventRequest error', async () => {
    const error = new Error('Ooops!');
    revert = apiai.__set__('getApiAiInstance', () => ({
      eventRequest: () => {
        const testEmitter = new TestEmitter();
        setTimeout(() => {
          testEmitter.emit('error', error);
        }, 30);
        return testEmitter;
      }
    }));
    return assert.isRejected(apiai.processEvent('demo', 'test_sender_id'), Error, 'Ooops!');
  });

  it('Test processTextMessage with eventRequest', async () => {
    revert = apiai.__set__('getApiAiInstance', () => ({
      textRequest: () => {
        const testEmitter = new TestEmitter();
        setTimeout(() => {
          testEmitter.emit('response', demoResponse);
        }, 30);
        return testEmitter;
      }
    }));
    const response = await apiai.processTextMessage('demo', 'test_sender_id');
    assert.isOk(lodash.get(response, 'messages'));
    assert.isTrue(lodash.get(lodash.find(response.messages, 'speech'), 'speech') === 'Hello ?');
  });

  it('Test processTextMessage with eventRequest error', async () => {
    const error = new Error('Ooops!');
    revert = apiai.__set__('getApiAiInstance', () => ({
      textRequest: () => {
        const testEmitter = new TestEmitter();
        setTimeout(() => {
          testEmitter.emit('error', error);
        }, 30);
        return testEmitter;
      }
    }));
    return assert.isRejected(apiai.processTextMessage('demo', 'test_sender_id'), Error, 'Ooops!');
  });
});
