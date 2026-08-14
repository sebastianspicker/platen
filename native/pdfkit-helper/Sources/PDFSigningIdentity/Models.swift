import Foundation

let signingProtocolVersion = 1
let maxSigningRequestBytes = 65_536
let maxSigningResponseBytes = 262_144
let maxSigningInputBytes = 16 * 1_048_576
let maxSigningCMSBytes = 16 * 1_048_576
let signingInputFilename = "input.bin"
let signingOutputFilename = "detached.cms"
let signingVerifyInputFilename = "input.bin"
let signingVerifyCmsFilename = "detached.cms"

enum SigningFailure: Error {
    case invalidRequest
    case requestTooLarge
    case unsafeWorkspace
    case inputTooLarge
    case sourceDigestMismatch
    case identityNotFound
    case platformDenied
    case cmsFailed
    case outputExists
    case outputWriteFailed
    case responseTooLarge
    case cmsInvalid
    case cmsMultipleSigners
    case trustIndeterminate

    var code: String {
        switch self {
        case .invalidRequest: return "INVALID_REQUEST"
        case .requestTooLarge: return "REQUEST_TOO_LARGE"
        case .unsafeWorkspace: return "UNSAFE_WORKSPACE"
        case .inputTooLarge: return "INPUT_TOO_LARGE"
        case .sourceDigestMismatch: return "SOURCE_MISMATCH"
        case .identityNotFound: return "IDENTITY_NOT_FOUND"
        case .platformDenied: return "PLATFORM_DENIED"
        case .cmsFailed: return "CMS_FAILED"
        case .outputExists: return "OUTPUT_EXISTS"
        case .outputWriteFailed: return "OUTPUT_WRITE_FAILED"
        case .responseTooLarge: return "RESPONSE_TOO_LARGE"
        case .cmsInvalid: return "CMS_INVALID"
        case .cmsMultipleSigners: return "CMS_MULTIPLE_SIGNERS"
        case .trustIndeterminate: return "TRUST_INDETERMINATE"
        }
    }
}

struct SigningRequest: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String?
    let inputSha256: String?
    let certificateSha256: String?
    let cmsFilename: String?
    let cmsSha256: String?
}

struct CertificateReceipt: Encodable {
    let certificateSha256: String
    let certificateBytes: Int
}

struct SigningListResult: Encodable {
    let operation = "listSigningIdentities"
    let identities: [CertificateReceipt]
}

struct SigningCMSResult: Encodable {
    let operation = "createDetachedCMS"
    let certificateSha256: String
    let inputSha256: String
    let cmsSha256: String
    let cmsBytes: Int
    let outputFilename: String
}

struct VerifyCMSResult: Encodable {
    let operation = "verifyDetachedCMS"
    let inputSha256: String
    let cmsSha256: String
    let certificateSha256: String
    let signatureValid: Bool
    let trustStatus: String
    let trustReason: String
    let timestampValidated = false
    let ltv = false
    let revocationOnlineChecked = false
}

struct SigningSuccess<T: Encodable>: Encodable {
    let version = signingProtocolVersion
    let ok = true
    let result: T
}

struct SigningErrorBody: Encodable { let code: String }
struct SigningError: Encodable {
    let version = signingProtocolVersion
    let ok = false
    let error: SigningErrorBody
}
