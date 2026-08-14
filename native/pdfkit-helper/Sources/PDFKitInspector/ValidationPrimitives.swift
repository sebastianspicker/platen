import Foundation

func exactKeys(_ object: [String: Any], _ keys: [String]) -> Bool {
    Set(object.keys) == Set(keys)
}

func exactRectangle(_ value: Any?) -> Bool {
    guard let rectangle = value as? [String: Any] else { return false }
    return exactKeys(rectangle, ["x", "y", "width", "height"])
}

func exactMeasurementPoint(_ value: [String: Any]) -> Bool {
    exactKeys(value, ["x", "y"])
}

func exactNullableObject(_ value: Any?, keys: [String]) -> Bool {
    value is NSNull || ((value as? [String: Any]).map { exactKeys($0, keys) } ?? false)
}

func exactInteger(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          !CFNumberIsFloatType(number)
    else { return false }
    return true
}

func isWithin(_ value: Int, _ minimum: Int, _ maximum: Int) -> Bool {
    value >= minimum && value <= maximum
}

func isSafeFilename(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." && !value.hasPrefix("/")
        && !value.contains("/") && !value.contains("\\") && !value.contains("\0")
}

func isLowercaseSHA256(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { byte in
        (48...57).contains(byte) || (97...102).contains(byte)
    }
}
