import path from 'path';
import request from 'request-promise-native';
import { CookieJar } from 'tough-cookie';
import Ajv from 'ajv';
import he from 'he';
import base64 from 'base64-img';
import _ from 'lodash';
import { Importer, authStages, errors } from '@doc.ai/neuron-app';
import labCorpRawDataSchema from '../schemas/labCorpRawData.schema.json';

const LABCORP_BASE_URL = 'https://patientws.labcorp.com/patient-portal-ws';
const LABCORP_REDIRECT_URL =
  'https://labcorp.okta.com/app/labcorpplatformprod_patientportal_1/exk5u6y2v1EVfZB2t0x7/sso/saml?RelayState=angular2';
const OKTA_BASE_URL = 'https://labcorp.okta.com/';

const DEFAULT_REQUEST_OPTIONS = {
  followRedirect: true,
  followAllRedirects: true,
  gzip: true,
  noRequestId: true,
  json: true,
  headers: {
    'Accept-Encoding': 'gzip, deflate, br',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en,en-US;q=0.8',
    'Cache-Control': 'max-age=0',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': 1,
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/54.0.2840.71 Safari/537.36',
  },
};

const INDICATOR_MAP = {
  H: { text: 'High', type: 'error' },
  N: { text: 'Normal', type: 'normal' },
  L: { text: 'Low', type: 'error' },
};

function transformItem({
  units,
  referenceRange,
  abnormalIndicator,
  status,
  value,
  name,
  comments,
}) {
  if (value === null || status !== 'completed') {
    return null;
  }

  return {
    units,
    referenceRange: referenceRange ? referenceRange.split('-') : null,
    indicator: INDICATOR_MAP[abnormalIndicator],
    value,
    name,
    comments: JSON.stringify(comments),
  };
}

export default class LabCorpImporter extends Importer {
  static getSamlPayload(html) {
    const beginString = '<input name="SAMLResponse" type="hidden" value="';
    const endString = '"/>';
    const index = html.search(beginString);
    const part = html.substr(index + beginString.length);
    const endIndex = part.search(endString);
    const result = part.substr(0, endIndex);
    return result;
  }

  constructor(id, app, options = {}) {
    super(id, app, options);

    // TODO: https://github.com/doc-ai/node-neuron-app/issues/4
    let appConfig = _.get(app, 'config');
    if (!appConfig) {
      appConfig = _.get(app, 'app.config');
    }

    this.name = appConfig.custom.labCorp.name;
    this.groups = appConfig.custom.labCorp.groups.split(',');
    this.logo = base64.base64Sync(
      path.resolve(__dirname, '../assets/logo.png'),
    );

    this.options = options;

    this.addAuthStage(
      'loginPass',
      new authStages.FormAuthStage(
        {
          title: 'Patient Portal',
          logo: base64.base64Sync(
            path.resolve(__dirname, '../assets/logo.png'),
          ),
        },
        {
          fields: [
            {
              name: 'username',
              type: 'text',
            },
            {
              name: 'password',
              type: 'password',
            },
          ],
          confirmBtnText: 'Sign In',
        },
      ),
    );
  }

  serializeState() {
    const result = JSON.parse(JSON.stringify(this.state));

    if (this.state.jar) {
      // eslint-disable-next-line no-underscore-dangle
      result.jar = this.state.jar._jar.toJSON();
    }

    return result;
  }

  deserializeState(state) {
    const result = JSON.parse(JSON.stringify(state));

    if (state.jar) {
      const jar = request.jar();
      // eslint-disable-next-line no-underscore-dangle
      jar._jar = CookieJar.fromJSON(state.jar);
      result.jar = jar;
    }

    this.state = result;
  }

  getApiReq() {
    return request.defaults(
      Object.assign(
        {
          baseUrl: LABCORP_BASE_URL,
          jar: this.state.jar,
        },
        DEFAULT_REQUEST_OPTIONS,
      ),
    );
  }

  getOktaReq() {
    return request.defaults(
      Object.assign(
        {
          baseUrl: OKTA_BASE_URL,
          jar: this.state.jar,
        },
        DEFAULT_REQUEST_OPTIONS,
      ),
    );
  }

  async loginPassAuthStage({ username, password }) {
    await this.setStatus('Authentication... 0%');

    this.setState('jar', request.jar());

    try {
      const { sessionToken, _embedded } = await this.getOktaReq().post(
        '/api/v1/authn',
        {
          body: {
            username,
            password,
          },
        },
      );

      this.setState('oktaUser', _embedded);

      const samlResult = await this.getOktaReq().get(
        '/login/sessionCookieRedirect',
        {
          qs: {
            token: sessionToken,
            redirectUrl: LABCORP_REDIRECT_URL,
          },
        },
      );

      const samlPayload = this.constructor.getSamlPayload(samlResult);
      const samlResponse = he.decode(samlPayload);

      await this.getApiReq().post('/getToken', {
        formData: {
          SAMLResponse: samlResponse,
          RelayState: '',
        },
      });

      const loginResult = await this.getApiReq().post(
        '/api/patients/current/login',
      );

      this.setState('labCorpUser', loginResult);
    } catch (e) {
      if (e.error) {
        throw new errors.CollectorAuthError(e.error.errorSummary);
      }

      throw new errors.CollectorAuthError(e.message);
    }

    await this.setStatus('Authentication... 100%');
  }

  async collect() {
    const headers = await this.getApiReq().get(
      '/api/patients/current/results/headers',
    );

    const results = [];
    for (const item of headers) {
      const result = await this.getApiReq().get(
        `/api/patients/current/results/${item.id}`,
      );

      results.push(result);
    }

    return {
      oktaUser: this.state.oktaUser,
      labCorpUser: this.state.labCorpUser,
      results,
    };
  }

  async transform(rawData) {
    const ajv = new Ajv();
    const valid = ajv.validate(labCorpRawDataSchema, rawData);
    if (!valid) {
      throw new errors.TransformDataTypeError('Raw data format is not correct');
    }

    return rawData.results.map(result => {
      const categories = result.orderedItems
        .map(orderedItem => {
          const items = orderedItem.results
            .map(transformItem)
            .filter(item => !!item);
          if (items.length === 0) {
            return null;
          }

          return {
            name: orderedItem.testName,
            items,
          };
        })
        .filter(category => !!category);

      return {
        id: result.header.id,
        accountName: result.header.accountName,
        orderingProviderName: result.header.orderingProviderName,
        dateOfService: new Date(result.header.dateOfService),
        reportDate: new Date(result.header.reportDate).toISOString(),
        items: categories,
      };
    });
  }
}
