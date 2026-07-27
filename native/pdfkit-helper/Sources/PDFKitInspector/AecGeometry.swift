import Foundation
import PDFKit
import AppKit
import Darwin
import CryptoKit
import CoreGraphics


enum AecAnnotationGeometry {
    case line(CGPoint, CGPoint)
    case ink([CGPoint], Bool)
    case circle(CGPoint)
}

struct AecAnnotationExpectation {
    let subtype: String
    let contents: String
    let geometry: AecAnnotationGeometry
}

struct AecMeasurementSnapshot {
    let annotationCounts: [Int]
    let pageCount: Int
}

func point(_ value: MeasurementPoint) -> CGPoint {
    CGPoint(x: value.x, y: value.y)
}

func closeEnough(_ lhs: CGPoint, _ rhs: CGPoint) -> Bool {
    abs(lhs.x - rhs.x) <= 0.001 && abs(lhs.y - rhs.y) <= 0.001
}

func measurementDistance(_ lhs: CGPoint, _ rhs: CGPoint) -> Double {
    hypot(lhs.x - rhs.x, lhs.y - rhs.y)
}

func pointsAreDistinct(_ points: [CGPoint]) -> Bool {
    for left in points.indices {
        for right in points.indices where right > left {
            if measurementDistance(points[left], points[right]) <= 0.001 { return false }
        }
    }
    return true
}

func orientation(_ first: CGPoint, _ second: CGPoint, _ third: CGPoint) -> Double {
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x)
}

func segmentsIntersect(_ firstStart: CGPoint, _ firstEnd: CGPoint, _ secondStart: CGPoint, _ secondEnd: CGPoint) -> Bool {
    let epsilon = 0.001
    let first = orientation(firstStart, firstEnd, secondStart)
    let second = orientation(firstStart, firstEnd, secondEnd)
    let third = orientation(secondStart, secondEnd, firstStart)
    let fourth = orientation(secondStart, secondEnd, firstEnd)
    if abs(first) > epsilon && abs(second) > epsilon && abs(third) > epsilon && abs(fourth) > epsilon
        && (first > 0) != (second > 0) && (third > 0) != (fourth > 0) {
        return true
    }
    func liesOnSegment(_ point: CGPoint, _ start: CGPoint, _ end: CGPoint, _ orientation: Double) -> Bool {
        abs(orientation) <= epsilon
            && point.x >= min(start.x, end.x) - epsilon && point.x <= max(start.x, end.x) + epsilon
            && point.y >= min(start.y, end.y) - epsilon && point.y <= max(start.y, end.y) + epsilon
    }
    return liesOnSegment(secondStart, firstStart, firstEnd, first)
        || liesOnSegment(secondEnd, firstStart, firstEnd, second)
        || liesOnSegment(firstStart, secondStart, secondEnd, third)
        || liesOnSegment(firstEnd, secondStart, secondEnd, fourth)
}

func polylineIsSimple(_ points: [CGPoint], closed: Bool) -> Bool {
    let edges = closed ? points.count : points.count - 1
    guard edges > 0 else { return false }
    for first in 0..<edges {
        let firstEnd = (first + 1) % points.count
        for second in (first + 1)..<edges {
            let secondEnd = (second + 1) % points.count
            if first == second || firstEnd == second || secondEnd == first { continue }
            if segmentsIntersect(points[first], points[firstEnd], points[second], points[secondEnd]) { return false }
        }
    }
    return true
}

func signedArea(_ points: [CGPoint]) -> Double {
    guard points.count >= 3 else { return 0 }
    var area = 0.0
    for index in points.indices {
        let next = points[(index + 1) % points.count]
        area += Double(points[index].x * next.y - next.x * points[index].y) / 2
    }
    return area
}

func polylineLength(_ points: [CGPoint], closed: Bool) -> Double {
    guard points.count >= 2 else { return 0 }
    var result = zip(points, points.dropFirst()).reduce(0) { $0 + measurementDistance($1.0, $1.1) }
    if closed { result += measurementDistance(points[points.count - 1], points[0]) }
    return result
}

func closeEnough(_ lhs: Double, _ rhs: Double) -> Bool {
    let tolerance = max(0.000001, max(abs(lhs), abs(rhs)) * 0.000001)
    return abs(lhs - rhs) <= tolerance
}

func metersPerSourceUnit(_ value: String) -> Double? {
    switch value {
    case "mm": return 0.001
    case "cm": return 0.01
    case "m": return 1
    case "in": return 0.0254
    case "ft": return 0.3048
    default: return nil
    }
}

func containedInCropBox(_ points: [CGPoint], page: PDFPage) -> Bool {
    let crop = page.bounds(for: .cropBox)
    return !crop.isNull && !crop.isInfinite && points.allSatisfy(crop.contains)
}

func aecMeasurementCanApply(_ measurement: AecMeasurement, document: PDFDocument, limits: Limits) -> Bool {
    guard !document.isEncrypted, !document.isLocked, document.allowsCommenting,
          !documentHasActionsOrSignatureWidgets(document),
          !documentHasWidgets(document), !catalogContainsAecUnsupportedContent(document),
          isWithin(document.pageCount, 1, limits.maxPages), measurement.page <= document.pageCount,
          let page = document.page(at: measurement.page - 1)
    else { return false }
    let points = measurement.points.map(point)
    guard containedInCropBox(points, page: page), pointsAreDistinct(points) else { return false }
    let calibration = measurement.calibration
    if measurement.kind != "count" {
        guard let calibration else { return false }
        let calibrationPoints = calibration.points.map(point)
        guard containedInCropBox(calibrationPoints, page: page), pointsAreDistinct(calibrationPoints),
              let sourceUnitMeters = metersPerSourceUnit(calibration.sourceUnit)
        else { return false }
        let calibrationDistance = measurementDistance(calibrationPoints[0], calibrationPoints[1])
        guard calibrationDistance > 0.001,
              closeEnough(calibration.metersPerPoint, calibration.realLength * sourceUnitMeters / calibrationDistance)
        else { return false }
    }
    let closed = measurement.kind == "perimeter" || measurement.kind == "area"
    guard measurement.kind == "count" || polylineIsSimple(points, closed: closed) else { return false }
    let expectedQuantity: Double
    switch measurement.kind {
    case "distance": expectedQuantity = polylineLength(points, closed: false) * (calibration?.metersPerPoint ?? 0)
    case "perimeter":
        guard abs(signedArea(points)) > 0.001 else { return false }
        expectedQuantity = polylineLength(points, closed: true) * (calibration?.metersPerPoint ?? 0)
    case "area":
        let area = abs(signedArea(points))
        guard area > 0.001 else { return false }
        let metersPerPoint = calibration?.metersPerPoint ?? 0
        expectedQuantity = area * metersPerPoint * metersPerPoint
    case "count": expectedQuantity = Double(points.count)
    default: return false
    }
    guard closeEnough(measurement.quantity, expectedQuantity) else { return false }
    let annotationCount = measurement.kind == "count" ? points.count : 1
    for pageIndex in 0..<document.pageCount {
        guard let candidate = document.page(at: pageIndex), candidate.annotations.count <= limits.maxAnnotationsPerPage else { return false }
        let expectedCount = candidate.annotations.count + (pageIndex == measurement.page - 1 ? annotationCount : 0)
        guard expectedCount <= maximumAnnotationsPerPage, expectedCount <= limits.maxAnnotationsPerPage else { return false }
    }
    return true
}

func aecContents(_ measurement: AecMeasurement) -> String {
    "AEC \(measurement.kind) \(measurement.quantity) \(measurement.unit): \(measurement.label)"
}

func boundedGeometryRect(_ points: [CGPoint], crop: CGRect) -> CGRect? {
    guard let first = points.first else { return nil }
    var minimumX = first.x
    var maximumX = first.x
    var minimumY = first.y
    var maximumY = first.y
    for value in points.dropFirst() {
        minimumX = min(minimumX, value.x); maximumX = max(maximumX, value.x)
        minimumY = min(minimumY, value.y); maximumY = max(maximumY, value.y)
    }
    let padding = min(0.5, min(crop.width, crop.height) / 4)
    let minimumWidth = min(1, crop.width)
    let minimumHeight = min(1, crop.height)
    func boundedInterval(_ minimum: CGFloat, _ maximum: CGFloat, _ lower: CGFloat, _ upper: CGFloat, _ minimumSize: CGFloat) -> (CGFloat, CGFloat)? {
        guard upper > lower, minimumSize > 0, upper - lower >= minimumSize else { return nil }
        var start = max(lower, minimum - padding)
        var end = min(upper, maximum + padding)
        if end - start < minimumSize {
            start = min(max((minimum + maximum) / 2 - minimumSize / 2, lower), upper - minimumSize)
            end = start + minimumSize
        }
        return end > start ? (start, end) : nil
    }
    guard let horizontal = boundedInterval(minimumX, maximumX, crop.minX, crop.maxX, minimumWidth),
          let vertical = boundedInterval(minimumY, maximumY, crop.minY, crop.maxY, minimumHeight)
    else { return nil }
    let rect = CGRect(x: horizontal.0, y: vertical.0, width: horizontal.1 - horizontal.0, height: vertical.1 - vertical.0)
    return rect.width > 0 && rect.height > 0 && crop.contains(rect) ? rect : nil
}

func markerRect(at point: CGPoint, crop: CGRect) -> CGRect? {
    let size = min(4, min(crop.width, crop.height))
    guard size > 0 else { return nil }
    let originX = min(max(point.x - size / 2, crop.minX), crop.maxX - size)
    let originY = min(max(point.y - size / 2, crop.minY), crop.maxY - size)
    let rect = CGRect(x: originX, y: originY, width: size, height: size)
    return crop.contains(rect) && rect.contains(point) ? rect : nil
}

func annotationSpacePoint(_ point: CGPoint, bounds: CGRect) -> CGPoint {
    CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY)
}
