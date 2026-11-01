import React, { useEffect, useState } from 'react';

import { Box } from '@mui/system';
import { Button } from '@mui/material';

import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { IJaiCompletionProvider } from '../tokens';
import { CustomModelsInput } from './settings/custom-models-input';
import { SecretsSection } from './settings/secrets-section';

type ChatSettingsProps = {
  rmRegistry: IRenderMimeRegistry;
  completionProvider: IJaiCompletionProvider | null;
  openInlineCompleterSettings: () => void;
};

/**
 * Component that returns the settings view in the chat panel.
 *
 * As of Jupyter AI v3.1, the chat model is chosen per-user, per-chat in the
 * model picker rather than configured globally here, so the chat/completion
 * model ID inputs have been removed. This view is now where users define the
 * *custom models* that populate that picker, plus manage secrets/API keys.
 */
export function ChatSettings(props: ChatSettingsProps): JSX.Element {
  const [inlineCompletionsEnabled, setInlineCompletionsEnabled] = useState(
    props.completionProvider?.isEnabled() ?? false
  );

  useEffect(() => {
    const provider = props.completionProvider;
    if (!provider) {
      setInlineCompletionsEnabled(false);
      return;
    }
    const updateEnabled = () =>
      setInlineCompletionsEnabled(provider.isEnabled());
    provider.settingsChanged.connect(updateEnabled);
    updateEnabled();
    return () => {
      provider.settingsChanged.disconnect(updateEnabled);
    };
  }, [props.completionProvider]);

  return (
    <Box
      className="jp-ai-ChatSettings"
      sx={{
        '& .MuiAlert-root': {
          marginTop: 2
        }
      }}
    >
      {/* SECTION: Custom models */}
      <h2 className="jp-ai-ChatSettings-header">Custom models</h2>
      <p>
        Define custom models for Jupyternaut. Each custom model has a name, an
        optional description, a model ID accepted by LiteLLM (e.g.{' '}
        <code>openai/hermes</code>), and model parameters passed to the agent.
        Saved custom models appear at the top of the model picker, in the order
        shown here.
      </p>
      <p>
        Model IDs follow the{' '}
        <a
          href="https://docs.litellm.ai/docs/providers"
          target="_blank"
          rel="noopener noreferrer"
        >
          LiteLLM documentation
        </a>
        .
      </p>
      <CustomModelsInput />

      {/* SECTION: Inline code completions */}
      <h2 className="jp-ai-ChatSettings-header">Inline code completions</h2>
      {props.completionProvider ? (
        <>
          <p>
            Jupyter AI can suggest code at the cursor. Press Tab to accept a
            suggestion. To improve data-science completions, the active kernel's
            variable names/types and DataFrame schema plus nearby CSV/Excel file
            names may be sent to your configured model; row samples and file
            contents are not sent. Current status:{' '}
            <strong>{inlineCompletionsEnabled ? 'enabled' : 'disabled'}</strong>
            .
          </p>
          <Button
            variant="outlined"
            onClick={props.openInlineCompleterSettings}
            sx={{ marginBottom: 2 }}
          >
            Configure inline completion settings
          </Button>
        </>
      ) : (
        <p>
          Inline completion is unavailable in this JupyterLab version.
          JupyterLab 4.1 or newer is required.
        </p>
      )}

      {/* SECTION: Secrets (and API keys) */}
      <h2 className="jp-ai-ChatSettings-header">Secrets and API keys</h2>
      <SecretsSection />
    </Box>
  );
}
