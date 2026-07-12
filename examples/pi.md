# Pi

Add this provider to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "model-router": {
      "baseUrl": "http://127.0.0.1:8856/v1",
      "api": "openai-completions",
      "apiKey": "MODEL_ROUTER_AUTH_TOKEN",
      "compat": {
        "supportsUsageInStreaming": true,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "auto",
          "name": "Automatic router selection",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Then set `defaultProvider` to `model-router` and `defaultModel` to `auto` in `~/.pi/agent/settings.json`, or select it interactively with `/model`.
