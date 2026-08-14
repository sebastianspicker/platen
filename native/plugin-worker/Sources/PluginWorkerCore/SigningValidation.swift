import Foundation
import Security
import CryptoKit

public struct SigningAttestation {
    public let teamIdentifier: String
    public let supervisorCdHash: String
    public let workerCdHash: String
    public let designatedRequirementSha256: String

    public init(teamIdentifier: String, supervisorCdHash: String, workerCdHash: String, designatedRequirementSha256: String) {
        self.teamIdentifier = teamIdentifier; self.supervisorCdHash = supervisorCdHash
        self.workerCdHash = workerCdHash; self.designatedRequirementSha256 = designatedRequirementSha256
    }
}

public enum SigningValidation {
    private static let workerIdentifier = "org.platen.PDFPluginWorker"
    private static let supervisorIdentifier = "org.platen.PDFPluginSupervisor"

    public static func attest(supervisor: URL, worker: URL, workerPID: pid_t) throws -> SigningAttestation {
        let supervisorStatic = try inspectStatic(at: supervisor)
        guard validTeam(supervisorStatic.teamIdentifier) else { throw PluginWorkerError("PLUGIN_TEAM_IDENTIFIER_INVALID") }
        let team = supervisorStatic.teamIdentifier
        let supervisorRequirement = requirementText(identifier: supervisorIdentifier, team: team)
        try validate(static: supervisorStatic, text: supervisorRequirement)
        let workerStatic = try inspectStatic(at: worker)
        guard workerStatic.teamIdentifier == team else { throw PluginWorkerError("PLUGIN_TEAM_IDENTIFIER_MISMATCH") }
        let workerRequirement = requirementText(identifier: workerIdentifier, team: team)
        try validate(static: workerStatic, text: workerRequirement)
        let current = try inspectCurrent(requirement: supervisorRequirement)
        guard current.teamIdentifier == team, current.cdHash == supervisorStatic.cdHash else { throw PluginWorkerError("PLUGIN_SUPERVISOR_IDENTITY_MISMATCH") }
        let liveWorker = try inspectGuest(pid: workerPID, requirement: workerRequirement)
        guard liveWorker.teamIdentifier == team, liveWorker.cdHash == workerStatic.cdHash else { throw PluginWorkerError("PLUGIN_WORKER_IDENTITY_MISMATCH") }
        return SigningAttestation(teamIdentifier: team, supervisorCdHash: supervisorStatic.cdHash, workerCdHash: workerStatic.cdHash, designatedRequirementSha256: SHA256.hash(data: Data((supervisorRequirement + "\n" + workerRequirement).utf8)).hex)
    }

    private static func inspectStatic(at url: URL) throws -> SignedCode {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { throw PluginWorkerError("PLUGIN_STATIC_IDENTITY_INVALID") }
        return try inspect(unsafeBitCast(code, to: SecCode.self), staticCode: code)
    }

    private static func validate(static evidence: SignedCode, text: String) throws {
        let flags = SecCSFlags(rawValue: UInt32(kSecCSStrictValidate | kSecCSCheckAllArchitectures))
        guard SecStaticCodeCheckValidity(evidence.staticCode, flags, requirement(text)) == errSecSuccess else { throw PluginWorkerError("PLUGIN_STATIC_IDENTITY_INVALID") }
        guard evidence.hardenedRuntime else { throw PluginWorkerError("PLUGIN_HARDENED_RUNTIME_INVALID") }
        try validateEntitlements(evidence.entitlements, team: evidence.teamIdentifier)
    }

    private static func inspectCurrent(requirement text: String) throws -> LiveCode {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, [], requirement(text)) == errSecSuccess else { throw PluginWorkerError("PLUGIN_SUPERVISOR_IDENTITY_INVALID") }
        return try liveEvidence(code)
    }

    private static func inspectGuest(pid: pid_t, requirement text: String) throws -> LiveCode {
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, [], requirement(text)) == errSecSuccess else { throw PluginWorkerError("PLUGIN_LIVE_IDENTITY_INVALID") }
        return try liveEvidence(code)
    }

    private static func inspect(_ code: SecCode, staticCode: SecStaticCode) throws -> SignedCode {
        let info = try signingInfo(code)
        return SignedCode(staticCode: staticCode, teamIdentifier: try team(info), cdHash: try cdHash(info), hardenedRuntime: runtime(info), entitlements: try entitlements(info))
    }

    private static func liveEvidence(_ code: SecCode) throws -> LiveCode {
        let info = try signingInfo(code)
        guard runtime(info) else { throw PluginWorkerError("PLUGIN_HARDENED_RUNTIME_INVALID") }
        return LiveCode(teamIdentifier: try team(info), cdHash: try cdHash(info))
    }

    private static func signingInfo(_ code: SecCode) throws -> NSDictionary {
        var information: CFDictionary?
        let staticView = unsafeBitCast(code, to: SecStaticCode.self)
        guard SecCodeCopySigningInformation(staticView, [], &information) == errSecSuccess, let information else { throw PluginWorkerError("PLUGIN_IDENTITY_UNAVAILABLE") }
        return information as NSDictionary
    }

    private static func team(_ information: NSDictionary) throws -> String {
        guard let value = information[kSecCodeInfoTeamIdentifier] as? String else { throw PluginWorkerError("PLUGIN_TEAM_IDENTIFIER_INVALID") }
        return value
    }

    private static func cdHash(_ information: NSDictionary) throws -> String {
        guard let value = information[kSecCodeInfoUnique] as? Data else { throw PluginWorkerError("PLUGIN_IDENTITY_UNAVAILABLE") }
        return value.map { String(format: "%02x", $0) }.joined()
    }

    private static func runtime(_ information: NSDictionary) -> Bool {
        guard let flags = information[kSecCodeInfoFlags] as? NSNumber else { return false }
        let hardenedRuntimeFlag: UInt32 = 0x0001_0000
        return flags.uint32Value & hardenedRuntimeFlag == hardenedRuntimeFlag
    }

    private static func entitlements(_ information: NSDictionary) throws -> [String: Any] {
        guard let value = information[kSecCodeInfoEntitlementsDict] as? [String: Any] else { throw PluginWorkerError("PLUGIN_SANDBOX_ENTITLEMENT_INVALID") }
        return value
    }

    private static func validateEntitlements(_ values: [String: Any], team: String) throws {
        guard Set(values.keys) == ["com.apple.security.app-sandbox"],
              values["com.apple.security.app-sandbox"] as? Bool == true,
              validTeam(team) else { throw PluginWorkerError("PLUGIN_SANDBOX_ENTITLEMENT_INVALID") }
    }

    private static func requirementText(identifier: String, team: String) -> String { "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\"" }
    private static func requirement(_ text: String) -> SecRequirement { var value: SecRequirement?; guard SecRequirementCreateWithString(text as CFString, [], &value) == errSecSuccess, let value else { fatalError("compile-time requirement invalid") }; return value }
    private static func validTeam(_ value: String) -> Bool { value.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil }
}

private struct SignedCode {
    let staticCode: SecStaticCode
    let teamIdentifier: String
    let cdHash: String
    let hardenedRuntime: Bool
    let entitlements: [String: Any]
}

private struct LiveCode {
    let teamIdentifier: String
    let cdHash: String
}

private extension Digest {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
