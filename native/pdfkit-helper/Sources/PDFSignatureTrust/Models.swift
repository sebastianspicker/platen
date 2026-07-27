import Foundation

let trustProtocolVersion = 1
let maxTrustRequestBytes = 65_536
let maxTrustResponseBytes = 262_144
let fixedLimits = TrustLimits(
    maxPdfBytes: 134_217_728,
    maxSignatures: 100,
    maxCmsBytesPerSignature: 1_048_576,
    maxCmsBytesTotal: 8_388_608,
    maxCertificatesPerSignature: 16,
    maxCertificateBytes: 65_536,
    maxBerDepth: 32,
    maxBerNodes: 32_768
)

enum TrustFailure: Error {
    case invalidRequest
    case requestTooLarge
    case unsafeWorkspace
    case inputTooLarge
    case sourceDigestMismatch
    case unreadablePDF
    case resourceLimit
    case responseTooLarge

    var code: String {
        switch self {
        case .invalidRequest: return "INVALID_REQUEST"
        case .requestTooLarge: return "REQUEST_TOO_LARGE"
        case .unsafeWorkspace: return "UNSAFE_WORKSPACE"
        case .inputTooLarge: return "INPUT_TOO_LARGE"
        case .sourceDigestMismatch: return "SOURCE_MISMATCH"
        case .unreadablePDF: return "DOCUMENT_UNREADABLE"
        case .resourceLimit: return "RESOURCE_LIMIT"
        case .responseTooLarge: return "RESPONSE_TOO_LARGE"
        }
    }
}

struct TrustLimits: Codable, Equatable {
    let maxPdfBytes: Int
    let maxSignatures: Int
    let maxCmsBytesPerSignature: Int
    let maxCmsBytesTotal: Int
    let maxCertificatesPerSignature: Int
    let maxCertificateBytes: Int
    let maxBerDepth: Int
    let maxBerNodes: Int
}

struct TrustRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let sourceSha256: String
    let limits: TrustLimits
    let records: [TrustRequestRecord]
}

struct TrustRequestRecord: Decodable {
    let byteRange: [Int64]
    let subFilter: String?
    let cmsFilename: String
    let cmsSha256: String
}

struct CertificateChain: Encodable {
    let status: String
    let reason: String
    let chainLength: Int?

    private enum CodingKeys: String, CodingKey {
        case status
        case reason
        case chainLength
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encode(reason, forKey: .reason)
        if let chainLength {
            try container.encode(chainLength, forKey: .chainLength)
        } else {
            try container.encodeNil(forKey: .chainLength)
        }
    }
}

struct SignatureRecord: Encodable {
    let byteRange: [Int64]
    let subFilter: String?
    let cmsSha256: String
    let certificateChain: CertificateChain

    private enum CodingKeys: String, CodingKey {
        case byteRange
        case subFilter
        case cmsSha256
        case certificateChain
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(byteRange, forKey: .byteRange)
        if let subFilter { try container.encode(subFilter, forKey: .subFilter) }
        else { try container.encodeNil(forKey: .subFilter) }
        try container.encode(cmsSha256, forKey: .cmsSha256)
        try container.encode(certificateChain, forKey: .certificateChain)
    }
}

struct TrustReceipt: Encodable {
    let schema = "macos-signature-chain-receipt-v2"
    let profile = "macos-basic-x509-current-trust-v2"
    let sourceSha256: String
    let evaluatedAt: String
    let verificationTimeBasis = "host-current-time"
    let anchorBasis = "current-macos-trust-configuration"
    let certificateNetworkFetchAllowed = false
    let records: [SignatureRecord]
}

struct TrustSuccess: Encodable {
    let version = trustProtocolVersion
    let ok = true
    let result: TrustReceipt
}

struct TrustErrorBody: Encodable { let code: String }
struct TrustError: Encodable {
    let version = trustProtocolVersion
    let ok = false
    let error: TrustErrorBody
}
