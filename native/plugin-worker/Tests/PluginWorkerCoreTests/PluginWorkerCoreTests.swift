import XCTest
@testable import PluginWorkerCore

final class PluginWorkerCoreTests: XCTestCase {
    func testCanonicalControlRoundTrip() throws {
        let invocation = Invocation(
            pluginId: "org.platen.example", version: "1.0.0", packageHash: String(repeating: "a", count: 64),
            activationId: "activation_12345678", operationId: "operation_12345678", nonce: String(repeating: "b", count: 64),
            capability: "document.example", documentHandle: "pdfh_" + String(repeating: "c", count: 64), input: .object(["pages": .array([.number(1)])])
        )
        let frameData = try invocation.controlFrame()
        XCTAssertEqual(try Invocation.decodeControl(unframe(frameData)), invocation)
    }

    func testHostileFramesFailClosed() throws {
        XCTAssertThrowsError(try JSONValue.parse(Data("{\"b\":1,\"a\":2}".utf8)))
        XCTAssertThrowsError(try unframe(Data([0, 0, 0, 2, 123])))
        XCTAssertThrowsError(try ScriptPolicy.validate(Data("import x from 'x'".utf8)))
        XCTAssertThrowsError(try ScriptPolicy.validate(Data("registerPlugin({invoke: eval})".utf8)))
        XCTAssertThrowsError(try ScriptPolicy.validate(Data(repeating: 65, count: 1_048_577)))
    }

    func testCanonicalNumbersMatchEcmaJsonFormattingWithoutIntegerTraps() throws {
        let cases: [(Double, String)] = [
            (-0.0, "0"), (0.1, "0.1"), (0.000001, "0.000001"),
            (0.0000001, "1e-7"), (100_000_000_000_000_000_000.0, "100000000000000000000"),
            (1_000_000_000_000_000_000_000.0, "1e+21"),
        ]
        for (value, expected) in cases {
            XCTAssertEqual(String(data: try JSONValue.number(value).canonicalData(), encoding: .utf8), expected)
            XCTAssertEqual(try JSONValue.parse(Data(expected.utf8)), .number(value))
        }
    }

    func testSingleRegistrationAndJsonResult() throws {
        let source = Data("registerPlugin({invoke: (input) => ({value: input.value})});".utf8)
        let plugin = try JavaScriptPlugin(source: source)
        XCTAssertEqual(try plugin.invoke(.object(["value": .string("ok")])), .object(["value": .string("ok")]))
        XCTAssertThrowsError(try JavaScriptPlugin(source: Data("registerPlugin({invoke:()=>({})});registerPlugin({invoke:()=>({})});".utf8)))
    }

    func testReadyAttestationIsExactAndDoesNotPromoteUnavailableMemoryLimit() throws {
        let preparation = Preparation(pluginId: "org.platen.example", version: "1.0.0", packageHash: String(repeating: "a", count: 64), sourceSha256: String(repeating: "b", count: 64), source: Data("x".utf8))
        let signing = SigningAttestation(teamIdentifier: "ABCDE12345", supervisorCdHash: String(repeating: "c", count: 40), workerCdHash: String(repeating: "d", count: 40), designatedRequirementSha256: String(repeating: "e", count: 64))
        let limits = ResourceLimitEvidence(cpuQuota: true, hardMemoryQuota: false, processQuota: true, outputQuota: true)
        let payload = try JSONValue.parse(try unframe(readyAttestation(preparation, signing: signing, supervisorPID: 10, workerPID: 11, limits: limits)))
        guard case let .object(fields) = payload else { return XCTFail("attestation is not an object") }
        XCTAssertEqual(Set(fields.keys), ["appSandbox", "cpuQuota", "designatedRequirementSha256", "hardMemoryQuota", "liveCodeIdentity", "noNetwork", "outputQuota", "packageHash", "pluginId", "pluginVersion", "privateIpc", "processQuota", "protocol", "schema", "sourceBytesOnly", "sourceSha256", "staticCodeIdentity", "supervisorCdHash", "supervisorPid", "teamIdentifier", "type", "workerCdHash", "workerPid"])
        XCTAssertEqual(fields["hardMemoryQuota"], .bool(false))
        XCTAssertEqual(fields["schema"], .string("pdf-plugin-native-attestation-v1"))
    }
}
