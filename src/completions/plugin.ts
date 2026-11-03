import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { ICompletionProviderManager } from '@jupyterlab/completer';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { INotebookTracker } from '@jupyterlab/notebook';
import {
  IEditorLanguageRegistry,
  IEditorLanguage
} from '@jupyterlab/codemirror';
import { getEditor } from '../utils';
import { IJaiStatusItem, IJaiCompletionProvider } from '../tokens';
import { displayName, JaiInlineProvider } from './provider';
import { CompletionWebsocketHandler } from './handler';
import { JaiCompletionContextManager } from './context-manager';
import { AiService } from '../handler';

export namespace CommandIDs {
  /**
   * Command to toggle completions globally.
   */
  export const toggleCompletions = 'jupyter-ai:toggle-completions';
  /**
   * Command to toggle completions for specific language.
   */
  export const toggleLanguageCompletions =
    'jupyter-ai:toggle-language-completions';
}

const INLINE_COMPLETER_PLUGIN =
  '@jupyterlab/completer-extension:inline-completer';

/**
 * Type of the settings object for the inline completer plugin.
 */
type IcPluginSettings = ISettingRegistry.ISettings & {
  user: {
    providers?: {
      [key: string]: unknown;
      [JaiInlineProvider.ID]?: JaiInlineProvider.ISettings;
    };
  };
  composite: {
    providers: {
      [key: string]: unknown;
      [JaiInlineProvider.ID]: JaiInlineProvider.ISettings;
    };
  };
};

type JaiCompletionToken = IJaiCompletionProvider | null;

export const completionPlugin: JupyterFrontEndPlugin<JaiCompletionToken> = {
  id: '@jupyter-ai/jupyternaut:inline-completions',
  autoStart: true,
  requires: [
    ICompletionProviderManager,
    IEditorLanguageRegistry,
    ISettingRegistry,
    INotebookTracker,
    IJaiStatusItem
  ],
  provides: IJaiCompletionProvider,
  activate: async (
    app: JupyterFrontEnd,
    completionManager: ICompletionProviderManager,
    languageRegistry: IEditorLanguageRegistry,
    settingRegistry: ISettingRegistry,
    notebookTracker: INotebookTracker,
    statusItem: IJaiStatusItem
  ): Promise<JaiCompletionToken> => {
    if (typeof completionManager.registerInlineProvider === 'undefined') {
      // Gracefully short-circuit on JupyterLab 4.0 and Notebook 7.0
      console.warn(
        'Inline completions are only supported in JupyterLab 4.1+ and Jupyter Notebook 7.1+'
      );
      return null;
    }

    const completionHandler = new CompletionWebsocketHandler();
    const contextManager = new JaiCompletionContextManager(
      app,
      notebookTracker
    );
    const provider = new JaiInlineProvider({
      completionHandler,
      languageRegistry,
      contextManager
    });

    try {
      await completionHandler.initialize();
    } catch (reason) {
      // Keep JupyterLab usable if the optional server-side completion endpoint
      // is unavailable. The client will reconnect after an abnormal close.
      console.warn(
        'Jupyter AI inline completion endpoint is unavailable.',
        reason
      );
    }
    completionManager.registerInlineProvider(provider);

    const findCurrentLanguage = (): IEditorLanguage | null => {
      const widget = app.shell.currentWidget;
      const editor = getEditor(widget);
      if (!editor) {
        return null;
      }
      return languageRegistry.findByMIME(editor.model.mimeType);
    };

    // ic := inline completion
    async function getIcSettings() {
      return (await settingRegistry.load(
        INLINE_COMPLETER_PLUGIN
      )) as IcPluginSettings;
    }

    /**
     * Gets the composite settings for the Jupyter AI inline completion provider
     * (JaiIcp).
     *
     * This reads from the `ISettings.composite` property, which merges the user
     * settings with the provider defaults, defined in
     * `JaiInlineProvider.DEFAULT_SETTINGS`.
     */
    async function getJaiIcpSettings() {
      const icSettings = await getIcSettings();
      return icSettings.composite.providers[JaiInlineProvider.ID];
    }

    /**
     * Updates the JaiIcp user settings.
     */
    async function updateJaiIcpSettings(
      newJaiIcpSettings: Partial<JaiInlineProvider.ISettings>
    ) {
      const icSettings = await getIcSettings();
      const oldUserIcpSettings = icSettings.user.providers;
      const newUserIcpSettings = {
        ...oldUserIcpSettings,
        [JaiInlineProvider.ID]: {
          ...oldUserIcpSettings?.[JaiInlineProvider.ID],
          ...newJaiIcpSettings
        }
      };
      icSettings.set('providers', newUserIcpSettings);
    }

    // Mito's first-run flow enables its provider once, while leaving an
    // explicit user choice untouched. Jupyter AI follows the same interaction
    // but keeps JupyterLab's history provider available alongside it.
    const enableOnFirstInstall = async (): Promise<void> => {
      try {
        const settings = await getIcSettings();
        const userProvider = settings.user.providers?.[JaiInlineProvider.ID] as
          | Partial<JaiInlineProvider.ISettings>
          | undefined;
        if (typeof userProvider?.enabled === 'boolean') {
          return;
        }
        const config = await AiService.getConfig();
        const modelAvailable = Boolean(
          config.completions_model_provider_id ||
            config.model_provider_id ||
            config.custom_models?.length
        );
        if (modelAvailable) {
          await updateJaiIcpSettings({ enabled: true });

          Notification.info(
            'Jupyter AI code completion is enabled. Press Tab to accept a suggestion; manage triggers in JupyterLab Settings.',
            { autoClose: 8000 }
          );
        }
      } catch (reason) {
        // The status-bar command and Settings editor remain available if the
        // settings or server config endpoint cannot be read during startup.
        console.warn(
          'Could not initialize Jupyter AI inline completion settings.',
          reason
        );
      }
    };
    // The core completer-extension plugin registers its settings transformer
    // for the inline completer inside `app.restored`, so loading the plugin
    // settings during startup would always fail with "has no transformers
    // yet". Wait for `app.restored` before the first-install enablement.
    void app.restored
      .then(() => enableOnFirstInstall())
      .catch((reason: unknown) => {
        console.warn(
          'Could not run the Jupyter AI inline completion first-install setup.',
          reason
        );
      });

    app.commands.addCommand(CommandIDs.toggleCompletions, {
      execute: async () => {
        const jaiIcpSettings = await getJaiIcpSettings();
        updateJaiIcpSettings({
          enabled: !jaiIcpSettings.enabled
        });
      },
      label: () =>
        provider.isEnabled()
          ? 'Disable code completions by Jupyternaut'
          : 'Enable code completions by Jupyternaut',
      isToggled: () => {
        return provider.isEnabled();
      }
    });

    app.commands.addCommand(CommandIDs.toggleLanguageCompletions, {
      execute: async () => {
        const jaiIcpSettings = await getJaiIcpSettings();
        const language = findCurrentLanguage();
        if (!language) {
          return;
        }

        const disabledLanguages = [...jaiIcpSettings.disabledLanguages];
        const newDisabledLanguages = disabledLanguages.includes(language.name)
          ? disabledLanguages.filter(l => l !== language.name)
          : disabledLanguages.concat(language.name);

        updateJaiIcpSettings({
          disabledLanguages: newDisabledLanguages
        });
      },
      // The label states the action, flipping like the global toggle's does,
      // so a checked item never shows an action it would not perform.
      label: () => {
        const language = findCurrentLanguage();
        if (!language) {
          return 'Disable completions in <language> files';
        }
        return provider.isLanguageEnabled(language.name)
          ? `Disable completions in ${displayName(language)}`
          : `Enable completions in ${displayName(language)}`;
      },
      // Same convention as the global toggle above: the checkmark means
      // "AI completions are currently ENABLED for this language", and the
      // label below is the action clicking performs. The previous semantics
      // (checkmark = language is in the disabled list) inverted the meaning
      // of the checkmark relative to the first menu item.
      isToggled: () => {
        const language = findCurrentLanguage();
        return !!language && provider.isLanguageEnabled(language.name);
      },
      isVisible: () => {
        const language = findCurrentLanguage();
        return !!language;
      },
      isEnabled: () => {
        const language = findCurrentLanguage();
        return !!language && provider.isEnabled();
      }
    });

    statusItem.addItem({
      command: CommandIDs.toggleCompletions,
      rank: 1
    });
    statusItem.addItem({
      command: CommandIDs.toggleLanguageCompletions,
      rank: 2
    });
    return provider;
  }
};
