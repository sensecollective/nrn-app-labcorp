import { App } from '@doc.ai/neuron-app';
import LabCorpImporter from './importers/LabCorpImporter';

async function main() {
  const app = new App({
    customConfig: {
      labCorp: {
        name: 'LabCorp',
        groups: 'proteome',
      },
    },
  });

  app.registerImporter('labCorp', LabCorpImporter);

  await app.start();
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err.stack);
  process.exit(1);
});
