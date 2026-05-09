import "should"
import { moonshotModels, openAiModelInfoSaneDefaults } from "@shared/api"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { OpenAiHandler } from "../core/api/providers/openai"

/**
 * Regression tests for issue #10544:
 *   "Moonshot Kimi K2.6 fails via OpenAI Compatible because Cline sends
 *    unsupported temperature"
 *
 * Moonshot's Kimi K2 series enforces a fixed temperature on the server side
 * (e.g. kimi-k2.6 only accepts `temperature: 1`). When a user reaches these
 * models through the generic OpenAI Compatible provider, Cline must resolve
 * the enforced temperature from the `moonshotModels` metadata instead of
 * relying on the user-configured or default value.
 */
describe("OpenAiHandler - Moonshot Kimi temperature enforcement", () => {
	afterEach(() => {
		sinon.restore()
	})

	const createAsyncIterable = (data: any[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	/**
	 * Builds an OpenAiHandler whose `ensureClient` is stubbed to a fake client
	 * so we can capture the outgoing chat.completions.create payload.
	 */
	const buildHandlerWithFakeClient = (options: ConstructorParameters<typeof OpenAiHandler>[0]) => {
		const handler = new OpenAiHandler(options)
		const createStub = sinon.stub().resolves(createAsyncIterable([]))
		const fakeClient = {
			chat: {
				completions: {
					create: createStub,
				},
			},
		}
		sinon.stub(handler as any, "ensureClient").returns(fakeClient as any)
		return { handler, createStub }
	}

	const drain = async (handler: OpenAiHandler) => {
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			// drain stream so @withRetry() resolves cleanly
		}
	}

	it("should enforce temperature=1 for kimi-k2.6 via OpenAI Compatible with moonshot base URL (fixes #10544)", async () => {
		const { handler, createStub } = buildHandlerWithFakeClient({
			openAiApiKey: "test-api-key",
			openAiBaseUrl: "https://api.moonshot.ai/v1",
			openAiModelId: "kimi-k2.6",
		})

		await drain(handler)

		const payload = createStub.firstCall.args[0]
		payload.temperature.should.equal(1)
		payload.temperature.should.equal(moonshotModels["kimi-k2.6"].temperature)
	})

	it("should enforce the metadata-defined temperature for kimi-k2.5 (reuses moonshotModels single source of truth)", async () => {
		const { handler, createStub } = buildHandlerWithFakeClient({
			openAiApiKey: "test-api-key",
			openAiBaseUrl: "https://api.moonshot.ai/v1",
			openAiModelId: "kimi-k2.5",
		})

		await drain(handler)

		const payload = createStub.firstCall.args[0]
		payload.temperature.should.equal(moonshotModels["kimi-k2.5"].temperature)
	})

	it("should override user-configured temperature when model enforces a fixed value", async () => {
		const { handler, createStub } = buildHandlerWithFakeClient({
			openAiApiKey: "test-api-key",
			openAiBaseUrl: "https://api.moonshot.ai/v1",
			openAiModelId: "kimi-k2.6",
			// User tries to set a custom temperature — server would reject it.
			openAiModelInfo: {
				...openAiModelInfoSaneDefaults,
				temperature: 0.5,
			},
		})

		await drain(handler)

		const payload = createStub.firstCall.args[0]
		payload.temperature.should.equal(1)
	})

	it("should match moonshot endpoints case-insensitively (e.g. uppercase host)", async () => {
		const { handler, createStub } = buildHandlerWithFakeClient({
			openAiApiKey: "test-api-key",
			openAiBaseUrl: "https://API.MOONSHOT.AI/v1",
			openAiModelId: "kimi-k2.6",
		})

		await drain(handler)

		const payload = createStub.firstCall.args[0]
		payload.temperature.should.equal(1)
	})

	it("should NOT override temperature for non-moonshot base URLs even when modelId collides with a moonshot id", async () => {
		const { handler, createStub } = buildHandlerWithFakeClient({
			openAiApiKey: "test-api-key",
			openAiBaseUrl: "https://api.example.com/v1",
			openAiModelId: "kimi-k2.6",
			openAiModelInfo: {
				...openAiModelInfoSaneDefaults,
				temperature: 0.3,
			},
		})

		await drain(handler)

		const payload = createStub.firstCall.args[0]
		// Custom value flows through (0.3 stays 0.3; only 0 is coerced to undefined).
		payload.temperature.should.equal(0.3)
	})

	it("should fall back to default behavior for unknown moonshot model ids", async () => {
		const { handler, createStub } = buildHandlerWithFakeClient({
			openAiApiKey: "test-api-key",
			openAiBaseUrl: "https://api.moonshot.ai/v1",
			openAiModelId: "kimi-unknown-future-model",
			openAiModelInfo: {
				...openAiModelInfoSaneDefaults,
				temperature: 0.7,
			},
		})

		await drain(handler)

		const payload = createStub.firstCall.args[0]
		// No moonshotModels match → user-provided value wins.
		payload.temperature.should.equal(0.7)
	})

	it("should coerce user temperature=0 to undefined for non-moonshot endpoints (preserves legacy OpenAI behavior)", async () => {
		const { handler, createStub } = buildHandlerWithFakeClient({
			openAiApiKey: "test-api-key",
			openAiBaseUrl: "https://api.example.com/v1",
			openAiModelId: "gpt-4o-mini",
			openAiModelInfo: {
				...openAiModelInfoSaneDefaults,
				temperature: 0,
			},
		})

		await drain(handler)

		const payload = createStub.firstCall.args[0]
		should(payload.temperature).be.undefined()
	})
})
