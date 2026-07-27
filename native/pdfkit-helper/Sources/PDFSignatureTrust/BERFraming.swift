import Foundation

enum BERFramingFailure: Error {
    case malformed
    case resourceLimit
}

private struct BERParser {
    let bytes: Data
    let maximumDepth: Int
    let maximumNodes: Int
    var cursor = 0
    var nodes = 0

    mutating func framedTopLevelSequence() throws -> Data {
        guard bytes.count >= 2, bytes[0] == 0x30 else { throw BERFramingFailure.malformed }
        try parseObject(depth: 1, limit: bytes.count)
        let framedEnd = cursor
        guard bytes[framedEnd...].allSatisfy({ $0 == 0 }) else { throw BERFramingFailure.malformed }
        return Data(bytes[..<framedEnd])
    }

    private mutating func parseObject(depth: Int, limit: Int) throws {
        guard depth <= maximumDepth else { throw BERFramingFailure.resourceLimit }
        guard cursor < limit else { throw BERFramingFailure.malformed }
        nodes += 1
        guard nodes <= maximumNodes else { throw BERFramingFailure.resourceLimit }

        let firstTag = bytes[cursor]
        cursor += 1
        if firstTag == 0 { throw BERFramingFailure.malformed }
        if firstTag & 0x1f == 0x1f { try parseHighTag(limit: limit) }
        guard cursor < limit else { throw BERFramingFailure.malformed }
        let firstLength = bytes[cursor]
        cursor += 1
        if firstLength == 0x80 {
            guard firstTag & 0x20 != 0 else { throw BERFramingFailure.malformed }
            try parseIndefiniteContents(depth: depth, limit: limit)
            return
        }
        let length = try definiteLength(firstByte: firstLength, limit: limit)
        guard length <= limit - cursor else { throw BERFramingFailure.malformed }
        let valueEnd = cursor + length
        if firstTag & 0x20 != 0 {
            while cursor < valueEnd { try parseObject(depth: depth + 1, limit: valueEnd) }
            guard cursor == valueEnd else { throw BERFramingFailure.malformed }
        } else {
            cursor = valueEnd
        }
    }

    private mutating func parseHighTag(limit: Int) throws {
        guard cursor < limit, bytes[cursor] & 0x7f != 0 else { throw BERFramingFailure.malformed }
        var octets = 0
        while true {
            guard cursor < limit, octets < 9 else { throw BERFramingFailure.malformed }
            let value = bytes[cursor]
            cursor += 1
            octets += 1
            if value & 0x80 == 0 { return }
        }
    }

    private mutating func definiteLength(firstByte: UInt8, limit: Int) throws -> Int {
        if firstByte < 0x80 { return Int(firstByte) }
        let octets = Int(firstByte & 0x7f)
        guard octets > 0, octets <= MemoryLayout<Int>.size,
              cursor <= limit - octets,
              bytes[cursor] != 0
        else { throw BERFramingFailure.malformed }
        var length = 0
        for _ in 0..<octets {
            guard length <= (Int.max >> 8) else { throw BERFramingFailure.malformed }
            length = (length << 8) | Int(bytes[cursor])
            cursor += 1
        }
        guard length >= 128 else { throw BERFramingFailure.malformed }
        return length
    }

    private mutating func parseIndefiniteContents(depth: Int, limit: Int) throws {
        while true {
            guard cursor < limit else { throw BERFramingFailure.malformed }
            if bytes[cursor] == 0 {
                guard cursor + 1 < limit, bytes[cursor + 1] == 0 else { throw BERFramingFailure.malformed }
                cursor += 2
                return
            }
            try parseObject(depth: depth + 1, limit: limit)
        }
    }
}

func frameCMSBER(_ bytes: Data, limits: TrustLimits) throws -> Data {
    var parser = BERParser(bytes: bytes, maximumDepth: limits.maxBerDepth, maximumNodes: limits.maxBerNodes)
    return try parser.framedTopLevelSequence()
}
