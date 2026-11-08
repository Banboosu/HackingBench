import type { AuthPrompt } from '@earendil-works/pi-ai';
import type { ExtensionContext, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, Input, renderFakeCursor, truncateToWidth } from '@earendil-works/pi-tui';
import { literalApiKey } from '../pi/project.js';

/** Pi 1.5's LoginDialog currently ignores AuthPrompt.type === secret.
 * Keep native /login/auth/storage, replacing only the secret prompt renderer. */
export class NativeSecretPrompts {
  context?: ExtensionContext;
  async prompt(prompt: AuthPrompt, signal?: AbortSignal): Promise<string> {
    const context = this.context;
    if (!context || context.mode !== 'tui') throw new Error('Secret entry requires the native TUI.');
    if (signal?.aborted || prompt.signal?.aborted) throw new Error('Login cancelled');
    const result = await context.ui.custom<string | undefined>((tui, theme, _keys, done) => {
      const input = new Input();
      input.onSubmit = value => done(value);
      input.onEscape = () => done(undefined);
      const cancel = () => done(undefined);
      signal?.addEventListener('abort', cancel, { once: true });
      prompt.signal?.addEventListener('abort', cancel, { once: true });
      return {
        get focused() { return input.focused; },
        set focused(value: boolean) { input.focused = value; },
        render(width: number) {
          const stars = '*'.repeat(Math.min(input.getValue().length, Math.max(0, width - 3)));
          return [
            truncateToWidth(theme.fg('accent', prompt.message), width),
            truncateToWidth(`> ${stars}${input.focused ? CURSOR_MARKER : ''}${renderFakeCursor(' ')}`, width),
            truncateToWidth(theme.fg('dim', 'Native /login | masked secret | Enter submits; Escape cancels'), width),
          ];
        },
        handleInput(data: string) { input.handleInput(data); tui.requestRender(); },
        invalidate() { input.invalidate(); },
        dispose() {
          signal?.removeEventListener('abort', cancel);
          prompt.signal?.removeEventListener('abort', cancel);
          input.setValue('');
        },
      };
    }, { blocked: { kind: 'auth', message: prompt.message } });
    if (result === undefined) throw new Error('Login cancelled');
    if (!literalApiKey(result)) throw new Error('Enter a literal API key, not a command or variable reference.');
    return result;
  }
  attach(runtime: ModelRuntime): void {
    const login = runtime.login.bind(runtime);
    runtime.login = (provider, type, interaction, options) => login(provider, type, {
      ...interaction,
      prompt: prompt => prompt.type === 'secret' ? this.prompt(prompt, interaction.signal) : interaction.prompt(prompt),
    }, options);
  }
}
