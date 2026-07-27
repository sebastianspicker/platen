import Foundation

private struct InjectedInfoValue {
    let range: Range<Int>
    let bytes: [UInt8]
}

private struct InjectedInfoDictionary {
    let body: Range<Int>
    let values: [String: InjectedInfoValue]
}

private struct InjectedInfoXref {
    let offset: Int
    let objectOffsets: [Int?]
    let trailer: [UInt8]
}

private func isMetadataWhitespace(_ byte: UInt8) -> Bool {
    byte == 0 || byte == 9 || byte == 10 || byte == 12 || byte == 13 || byte == 32
}

private func hasMetadataBytes(_ bytes: [UInt8], _ value: [UInt8], at index: Int) -> Bool {
    index >= 0 && index + value.count <= bytes.count
        && bytes[index..<(index + value.count)].elementsEqual(value)
}

private func metadataOccurrences(of value: [UInt8], in bytes: [UInt8]) -> Int {
    guard !value.isEmpty, bytes.count >= value.count else { return 0 }
    return (0...(bytes.count - value.count)).reduce(0) {
        $0 + (hasMetadataBytes(bytes, value, at: $1) ? 1 : 0)
    }
}

private func skipMetadataWhitespace(_ bytes: [UInt8], _ cursor: inout Int) {
    while cursor < bytes.count && isMetadataWhitespace(bytes[cursor]) { cursor += 1 }
}

private func parseMetadataUnsigned(
    _ bytes: [UInt8],
    _ cursor: inout Int,
    digits: Int? = nil
) -> Int? {
    let start = cursor
    var value = 0
    while cursor < bytes.count, (48...57).contains(bytes[cursor]) {
        guard value <= 10_000_000 else { return nil }
        value = value * 10 + Int(bytes[cursor] - 48)
        cursor += 1
    }
    guard cursor > start, digits.map({ cursor - start == $0 }) ?? true else { return nil }
    return value
}

private func parseMetadataName(_ bytes: [UInt8], _ cursor: inout Int) -> String? {
    guard cursor < bytes.count, bytes[cursor] == 47 else { return nil }
    cursor += 1
    let start = cursor
    while cursor < bytes.count,
          !isMetadataWhitespace(bytes[cursor]),
          ![40, 41, 60, 62, 91, 93, 47].contains(bytes[cursor]) {
        cursor += 1
    }
    guard cursor > start,
          let name = String(bytes: bytes[start..<cursor], encoding: .ascii)
    else { return nil }
    return name
}

private func parseMetadataLiteralString(_ bytes: [UInt8], _ cursor: inout Int) -> [UInt8]? {
    guard cursor < bytes.count, bytes[cursor] == 40 else { return nil }
    let start = cursor
    cursor += 1
    while cursor < bytes.count {
        if bytes[cursor] == 41 {
            cursor += 1
            return Array(bytes[start..<cursor])
        }
        if bytes[cursor] == 92 {
            guard cursor + 1 < bytes.count, [40, 41, 92].contains(bytes[cursor + 1]) else {
                return nil
            }
            cursor += 2
            continue
        }
        guard bytes[cursor] >= 32, bytes[cursor] <= 126, bytes[cursor] != 40 else {
            return nil
        }
        cursor += 1
    }
    return nil
}

private func injectedInfoXref(in bytes: [UInt8]) -> InjectedInfoXref? {
    let startXref = Array("startxref".utf8)
    guard metadataOccurrences(of: startXref, in: bytes) == 1,
          let startXrefIndex = (0...max(0, bytes.count - startXref.count)).first(where: {
              hasMetadataBytes(bytes, startXref, at: $0)
          })
    else { return nil }

    var endCursor = startXrefIndex + startXref.count
    skipMetadataWhitespace(bytes, &endCursor)
    guard let xrefOffset = parseMetadataUnsigned(bytes, &endCursor) else { return nil }
    skipMetadataWhitespace(bytes, &endCursor)
    guard hasMetadataBytes(bytes, Array("%%EOF".utf8), at: endCursor) else { return nil }
    endCursor += 5
    skipMetadataWhitespace(bytes, &endCursor)
    guard endCursor == bytes.count,
          xrefOffset < startXrefIndex,
          hasMetadataBytes(bytes, Array("xref".utf8), at: xrefOffset)
    else { return nil }

    var cursor = xrefOffset + 4
    skipMetadataWhitespace(bytes, &cursor)
    guard let first = parseMetadataUnsigned(bytes, &cursor), first == 0 else { return nil }
    skipMetadataWhitespace(bytes, &cursor)
    guard let count = parseMetadataUnsigned(bytes, &cursor), count >= 2, count <= 200_000 else {
        return nil
    }
    skipMetadataWhitespace(bytes, &cursor)

    var offsets = Array(repeating: Optional<Int>.none, count: count)
    for object in 0..<count {
        guard let offset = parseMetadataUnsigned(bytes, &cursor, digits: 10) else { return nil }
        skipMetadataWhitespace(bytes, &cursor)
        guard let generation = parseMetadataUnsigned(bytes, &cursor, digits: 5),
              generation == (object == 0 ? 65_535 : 0)
        else { return nil }
        skipMetadataWhitespace(bytes, &cursor)
        guard cursor < bytes.count, bytes[cursor] == (object == 0 ? 102 : 110) else {
            return nil
        }
        cursor += 1
        skipMetadataWhitespace(bytes, &cursor)
        if object > 0 { offsets[object] = offset }
    }

    guard hasMetadataBytes(bytes, Array("trailer".utf8), at: cursor) else { return nil }
    cursor += 7
    skipMetadataWhitespace(bytes, &cursor)
    let trailerStart = cursor
    guard hasMetadataBytes(bytes, [60, 60], at: cursor) else { return nil }
    cursor += 2
    while cursor + 1 < bytes.count, !hasMetadataBytes(bytes, [62, 62], at: cursor) {
        guard !hasMetadataBytes(bytes, [60, 60], at: cursor) else { return nil }
        cursor += 1
    }
    guard cursor + 1 < bytes.count else { return nil }
    let trailerEnd = cursor + 2
    let trailer = Array(bytes[trailerStart..<trailerEnd])
    return InjectedInfoXref(offset: xrefOffset, objectOffsets: offsets, trailer: trailer)
}

private func injectedInfoObject(in xref: InjectedInfoXref) -> (number: Int, offset: Int)? {
    let infoMarker = Array("/Info".utf8)
    guard metadataOccurrences(of: infoMarker, in: xref.trailer) == 1,
          metadataOccurrences(of: Array("/Prev".utf8), in: xref.trailer) == 0,
          let infoRelative = (0...max(0, xref.trailer.count - infoMarker.count)).first(where: {
              hasMetadataBytes(xref.trailer, infoMarker, at: $0)
          })
    else { return nil }

    var infoCursor = infoRelative + infoMarker.count
    skipMetadataWhitespace(xref.trailer, &infoCursor)
    guard let object = parseMetadataUnsigned(xref.trailer, &infoCursor),
          object > 0,
          object < xref.objectOffsets.count
    else { return nil }
    skipMetadataWhitespace(xref.trailer, &infoCursor)
    guard let generation = parseMetadataUnsigned(xref.trailer, &infoCursor), generation == 0 else {
        return nil
    }
    skipMetadataWhitespace(xref.trailer, &infoCursor)
    guard infoCursor < xref.trailer.count,
          xref.trailer[infoCursor] == 82,
          let objectOffset = xref.objectOffsets[object],
          objectOffset < xref.offset
    else { return nil }
    return (object, objectOffset)
}

private func injectedInfoDictionary(in data: Data) -> InjectedInfoDictionary? {
    let bytes = [UInt8](data)
    guard let xref = injectedInfoXref(in: bytes),
          let object = injectedInfoObject(in: xref)
    else { return nil }

    var cursor = object.offset
    guard let number = parseMetadataUnsigned(bytes, &cursor), number == object.number else {
        return nil
    }
    skipMetadataWhitespace(bytes, &cursor)
    guard let objectGeneration = parseMetadataUnsigned(bytes, &cursor), objectGeneration == 0 else {
        return nil
    }
    skipMetadataWhitespace(bytes, &cursor)
    guard hasMetadataBytes(bytes, Array("obj".utf8), at: cursor) else { return nil }
    cursor += 3
    skipMetadataWhitespace(bytes, &cursor)
    guard hasMetadataBytes(bytes, [60, 60], at: cursor) else { return nil }
    let bodyStart = cursor + 2
    cursor = bodyStart

    var keys: Set<String> = []
    var values: [String: InjectedInfoValue] = [:]
    while cursor + 1 < bytes.count, !hasMetadataBytes(bytes, [62, 62], at: cursor) {
        skipMetadataWhitespace(bytes, &cursor)
        guard !hasMetadataBytes(bytes, [62, 62], at: cursor),
              let key = parseMetadataName(bytes, &cursor),
              ["Producer", "CreationDate", "ModDate"].contains(key),
              keys.insert(key).inserted
        else { return nil }
        skipMetadataWhitespace(bytes, &cursor)
        let valueStart = cursor
        guard let value = parseMetadataLiteralString(bytes, &cursor),
              value.count > 2,
              value.count <= maximumStringLength + 2
        else { return nil }
        values[key] = InjectedInfoValue(range: valueStart..<cursor, bytes: value)
        skipMetadataWhitespace(bytes, &cursor)
    }
    guard keys == ["Producer", "CreationDate", "ModDate"], values.count == 3 else {
        return nil
    }
    let bodyEnd = cursor
    cursor += 2
    skipMetadataWhitespace(bytes, &cursor)
    guard hasMetadataBytes(bytes, Array("endobj".utf8), at: cursor) else { return nil }
    cursor += 6
    skipMetadataWhitespace(bytes, &cursor)
    guard cursor <= xref.offset else { return nil }
    return InjectedInfoDictionary(body: bodyStart..<bodyEnd, values: values)
}

func removeInjectedInfoDictionary(from data: Data) -> Data? {
    guard let info = injectedInfoDictionary(in: data) else { return nil }
    var bytes = [UInt8](data)
    for index in info.body { bytes[index] = 32 }
    guard info.values.values.allSatisfy({ metadataOccurrences(of: $0.bytes, in: bytes) == 0 }) else {
        return nil
    }
    return Data(bytes)
}

func restoreInjectedInfoDates(in data: Data, from source: Data) -> Data? {
    guard let target = injectedInfoDictionary(in: data),
          let original = injectedInfoDictionary(in: source)
    else { return nil }
    let dateKeys = ["CreationDate", "ModDate"]
    var bytes = [UInt8](data)
    for key in dateKeys {
        guard let targetValue = target.values[key],
              let originalValue = original.values[key],
              targetValue.bytes.count == originalValue.bytes.count
        else { return nil }
        bytes.replaceSubrange(targetValue.range, with: originalValue.bytes)
    }
    let restored = Data(bytes)
    guard let restoredInfo = injectedInfoDictionary(in: restored),
          dateKeys.allSatisfy({ restoredInfo.values[$0]?.bytes == original.values[$0]?.bytes })
    else { return nil }
    return restored
}
