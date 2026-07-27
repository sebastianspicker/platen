import Foundation

func encode(_ response: Encodable) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(AnyEncodable(response))
    guard data.count <= maxResponseBytes else { throw InspectionFailure.responseTooLarge }
    return data
}

struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

func emit(_ response: Encodable) {
    let data: Data
    do { data = try encode(response) }
    catch { data = Data("{\"error\":{\"code\":\"RESPONSE_TOO_LARGE\"},\"ok\":false,\"version\":1}".utf8) }
    FileHandle.standardOutput.write(data)
}

