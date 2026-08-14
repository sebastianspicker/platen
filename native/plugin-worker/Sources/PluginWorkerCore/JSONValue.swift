import Foundation
import CoreFoundation

public enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public static func parse(_ data: Data, maximumBytes: Int = 65_536) throws -> JSONValue {
        guard !data.isEmpty, data.count <= maximumBytes else {
            throw PluginWorkerError("PLUGIN_FRAME_INVALID")
        }
        let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        let value = try fromFoundation(object, depth: 0)
        guard try value.canonicalData() == data else { throw PluginWorkerError("PLUGIN_FRAME_NON_CANONICAL") }
        return value
    }

    public func canonicalData() throws -> Data {
        guard depth <= 8 else { throw PluginWorkerError("PLUGIN_FRAME_TOO_DEEP") }
        guard hasOnlyFiniteNumbers else { throw PluginWorkerError("PLUGIN_FRAME_INVALID") }
        return Data(canonicalString.utf8)
    }

    public var foundationValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        case .array(let value): return value.map(\.foundationValue)
        case .object(let value): return value.mapValues(\.foundationValue)
        }
    }

    private static func fromFoundation(_ input: Any, depth: Int) throws -> JSONValue {
        guard depth <= 8 else { throw PluginWorkerError("PLUGIN_FRAME_TOO_DEEP") }
        switch input {
        case is NSNull: return .null
        case let value as NSNumber where CFGetTypeID(value) == CFBooleanGetTypeID(): return .bool(value.boolValue)
        case let value as NSNumber: return .number(value.doubleValue)
        case let value as String:
            guard value.utf8.count <= 16_384 else { throw PluginWorkerError("PLUGIN_FRAME_TOO_LARGE") }
            return .string(value)
        case let value as [Any]: return .array(try value.map { try fromFoundation($0, depth: depth + 1) })
        case let value as [String: Any]:
            guard value.count <= 128 else { throw PluginWorkerError("PLUGIN_FRAME_TOO_LARGE") }
            return .object(try value.mapValues { try fromFoundation($0, depth: depth + 1) })
        default: throw PluginWorkerError("PLUGIN_FRAME_INVALID")
        }
    }

    private var depth: Int {
        switch self {
        case .array(let values): return 1 + (values.map(\.depth).max() ?? 0)
        case .object(let values): return 1 + (values.values.map(\.depth).max() ?? 0)
        default: return 0
        }
    }

    private var hasOnlyFiniteNumbers: Bool {
        switch self {
        case .number(let value): return value.isFinite
        case .array(let values): return values.allSatisfy(\.hasOnlyFiniteNumbers)
        case .object(let values): return values.values.allSatisfy(\.hasOnlyFiniteNumbers)
        default: return true
        }
    }

    private var canonicalString: String {
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value): return Self.canonicalNumber(value)
        case .string(let value): return String(data: try! JSONSerialization.data(withJSONObject: [value]), encoding: .utf8)!.dropFirst().dropLast().description
        case .array(let values): return "[" + values.map(\.canonicalString).joined(separator: ",") + "]"
        case .object(let values):
            return "{" + values.keys.sorted().map { key in
                JSONValue.string(key).canonicalString + ":" + values[key]!.canonicalString
            }.joined(separator: ",") + "}"
        }
    }

    private static func canonicalNumber(_ value: Double) -> String {
        guard value != 0 else { return "0" }
        let raw = String(value).lowercased()
        guard let exponentMarker = raw.firstIndex(of: "e") else {
            return raw.hasSuffix(".0") ? String(raw.dropLast(2)) : raw
        }
        let mantissa = String(raw[..<exponentMarker])
        let exponent = Int(raw[raw.index(after: exponentMarker)...])!
        let magnitude = abs(value)
        if magnitude >= 0.000001 && magnitude < 1_000_000_000_000_000_000_000 {
            return expandScientific(mantissa, exponent: exponent)
        }
        let normalizedMantissa = mantissa.hasSuffix(".0") ? String(mantissa.dropLast(2)) : mantissa
        return normalizedMantissa + "e" + (exponent >= 0 ? "+" : "") + String(exponent)
    }

    private static func expandScientific(_ mantissa: String, exponent: Int) -> String {
        let negative = mantissa.hasPrefix("-")
        let unsigned = negative ? String(mantissa.dropFirst()) : mantissa
        let components = unsigned.split(separator: ".", omittingEmptySubsequences: false)
        let integerDigits = components[0].count
        let digits = components.joined()
        let decimalIndex = integerDigits + exponent
        let expanded: String
        if decimalIndex <= 0 {
            expanded = "0." + String(repeating: "0", count: -decimalIndex) + digits
        } else if decimalIndex >= digits.count {
            expanded = digits + String(repeating: "0", count: decimalIndex - digits.count)
        } else {
            let split = digits.index(digits.startIndex, offsetBy: decimalIndex)
            expanded = String(digits[..<split]) + "." + String(digits[split...])
        }
        return negative ? "-" + expanded : expanded
    }
}
