import { pages, projectsModule, vibeModule } from '@navfolio/pages';
import { markdownPlugin } from '@navfolio/plugin-markdown';

import { defineNavfolioConfig } from './src/plugins/config';

export default defineNavfolioConfig({
  modules: [projectsModule(), vibeModule()],
  plugins: [
    markdownPlugin({
      expressiveCode: true,
      layouts: true,
      math: {
        enabled: false,
      },
      mermaid: false,
      responsiveTables: true,
    }),
    pages(),
  ],
});
