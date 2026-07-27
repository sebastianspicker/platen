import Foundation

let protocolVersion = 1
let maxRequestBytes = 8_192
let maxResponseBytes = 524_288
let maxInputBytes = 128 * 1_024 * 1_024
let maxOutputBytes = 128 * 1_024 * 1_024
let maximumPages = 100
let maximumAnnotationsPerPage = 50
let maximumWidgetsPerPage = 50
let maximumOutlineDepth = 8
let maximumOutlineItems = 200
let maximumStringLength = 1_024
let maximumChoiceOptions = 50
let maximumMutationEdits = 8
let maximumCoordinate = 1_000_000.0
let mutationInputFilename = "input.pdf"
let mutationOutputFilename = "output.pdf"

enum InspectionFailure: Error {
    case invalidRequest
    case requestTooLarge
    case unsafeWorkspace
    case inputTooLarge
    case unreadableDocument
    case responseTooLarge
    case outputExists
    case outputWriteFailed
    case mutationFailed
    case outputInvalid

    var code: String {
        switch self {
        case .invalidRequest: return "INVALID_REQUEST"
        case .requestTooLarge: return "REQUEST_TOO_LARGE"
        case .unsafeWorkspace: return "UNSAFE_WORKSPACE"
        case .inputTooLarge: return "INPUT_TOO_LARGE"
        case .unreadableDocument: return "UNREADABLE_DOCUMENT"
        case .responseTooLarge: return "RESPONSE_TOO_LARGE"
        case .outputExists: return "OUTPUT_EXISTS"
        case .outputWriteFailed: return "OUTPUT_WRITE_FAILED"
        case .mutationFailed: return "MUTATION_FAILED"
        case .outputInvalid: return "OUTPUT_INVALID"
        }
    }
}

struct Limits: Decodable {
    let maxPages: Int
    let maxAnnotationsPerPage: Int
    let maxWidgetsPerPage: Int
    let maxOutlineDepth: Int
    let maxOutlineItems: Int
}

struct Request: Decodable {
    let version: Int
    let operation: String
    let inputFilename: String
    let limits: Limits
}
