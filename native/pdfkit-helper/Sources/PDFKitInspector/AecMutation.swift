import Foundation
import PDFKit
import AppKit
import Darwin
import CryptoKit
import CoreGraphics


private func applyAecMeasurement(_ measurement: AecMeasurement, document: PDFDocument) -> [AecAnnotationExpectation]? {
    guard let page = document.page(at: measurement.page - 1) else { return nil }
    let points = measurement.points.map(point)
    let contents = aecContents(measurement)
    let crop = page.bounds(for: .cropBox)
    if measurement.kind == "count" {
        var expected: [AecAnnotationExpectation] = []
        for value in points {
            guard let bounds = markerRect(at: value, crop: crop) else { return nil }
            let annotation = PDFAnnotation(bounds: bounds, forType: .circle, withProperties: nil)
            annotation.contents = contents
            page.addAnnotation(annotation)
            expected.append(AecAnnotationExpectation(subtype: "circle", contents: contents, geometry: .circle(value)))
        }
        return expected
    }
    guard let bounds = boundedGeometryRect(points, crop: crop) else { return nil }
    if measurement.kind == "distance" && points.count == 2 {
        let annotation = PDFAnnotation(bounds: bounds, forType: .line, withProperties: nil)
        let start = annotationSpacePoint(points[0], bounds: bounds)
        let end = annotationSpacePoint(points[1], bounds: bounds)
        annotation.startPoint = start
        annotation.endPoint = end
        annotation.contents = contents
        page.addAnnotation(annotation)
        return [AecAnnotationExpectation(subtype: "line", contents: contents, geometry: .line(points[0], points[1]))]
    }
    let annotation = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
    let path = NSBezierPath()
    path.move(to: annotationSpacePoint(points[0], bounds: bounds))
    for value in points.dropFirst() { path.line(to: annotationSpacePoint(value, bounds: bounds)) }
    let closed = measurement.kind == "perimeter" || measurement.kind == "area"
    if closed { path.line(to: annotationSpacePoint(points[0], bounds: bounds)) }
    annotation.add(path)
    annotation.contents = contents
    page.addAnnotation(annotation)
    return [AecAnnotationExpectation(
        subtype: "ink", contents: contents, geometry: .ink(points, closed)
    )]
}

func pathMatches(_ path: NSBezierPath, points: [CGPoint], closed: Bool, origin: CGPoint) -> Bool {
    let expectedPoints = closed ? points + [points[0]] : points
    guard path.elementCount == expectedPoints.count else { return false }
    for index in expectedPoints.indices {
        var observed = NSPoint.zero
        let element = path.element(at: index, associatedPoints: &observed)
        let expectedElement: NSBezierPath.ElementType = index == 0 ? .moveTo : .lineTo
        let pagePoint = CGPoint(x: observed.x + origin.x, y: observed.y + origin.y)
        guard element == expectedElement, closeEnough(pagePoint, expectedPoints[index]) else { return false }
    }
    return true
}

private func verifiesAecAnnotation(_ annotation: PDFAnnotation, expected: AecAnnotationExpectation) -> Bool {
    guard annotationSubtype(annotation) == expected.subtype, annotation.contents == expected.contents,
          annotationIsInertTarget(annotation)
    else { return false }
    switch expected.geometry {
    case let .line(start, end):
        let observedStart = CGPoint(x: annotation.bounds.minX + annotation.startPoint.x, y: annotation.bounds.minY + annotation.startPoint.y)
        let observedEnd = CGPoint(x: annotation.bounds.minX + annotation.endPoint.x, y: annotation.bounds.minY + annotation.endPoint.y)
        return closeEnough(observedStart, start) && closeEnough(observedEnd, end)
    case let .ink(points, closed):
        guard let paths = annotation.paths, paths.count == 1,
              let path = paths.first else { return false }
        return pathMatches(path, points: points, closed: closed, origin: annotation.bounds.origin)
    case let .circle(point):
        return annotation.bounds.contains(point)
    }
}

private func verifiesAecMeasurement(
    document: PDFDocument,
    measurement: AecMeasurement,
    snapshot: AecMeasurementSnapshot,
    expected: [AecAnnotationExpectation]
) -> Bool {
    guard document.pageCount == snapshot.pageCount, expected.count > 0 else { return false }
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex) else { return false }
        let addedHere = pageIndex == measurement.page - 1 ? expected.count : 0
        guard page.annotations.count == snapshot.annotationCounts[pageIndex] + addedHere else { return false }
        if addedHere > 0 {
            let added = page.annotations.suffix(addedHere)
            guard zip(added, expected).allSatisfy({ verifiesAecAnnotation($0.0, expected: $0.1) }) else { return false }
        }
    }
    return true
}

func aecMeasurement(
    _ request: AecMeasurementRequest,
    workspace: URL,
    inputData: Data
) throws -> AecMeasurementReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard request.sourceSha256 == sourceDigest,
          let document = PDFDocument(data: inputData),
          aecMeasurementCanApply(request.measurement, document: document, limits: request.limits)
    else { throw InspectionFailure.mutationFailed }
    let snapshot = AecMeasurementSnapshot(
        annotationCounts: (0..<document.pageCount).compactMap { document.page(at: $0)?.annotations.count },
        pageCount: document.pageCount
    )
    guard snapshot.annotationCounts.count == document.pageCount,
          let expected = applyAecMeasurement(request.measurement, document: document),
          let outputData = document.dataRepresentation(), outputData.count <= maxOutputBytes
    else { throw InspectionFailure.mutationFailed }
    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    guard let reopened = PDFDocument(data: reopenedData),
          verifiesAecMeasurement(document: reopened, measurement: request.measurement, snapshot: snapshot, expected: expected)
    else { throw InspectionFailure.outputInvalid }
    return AecMeasurementReceipt(
        sourceSha256: sourceDigest,
        outputSha256: sha256Hex(reopenedData),
        measurementId: request.measurement.id,
        page: request.measurement.page,
        kind: request.measurement.kind,
        quantity: request.measurement.quantity,
        unit: request.measurement.unit,
        calibrationId: request.measurement.calibrationId,
        annotationCount: expected.count,
        annotationSubtypes: expected.map(\.subtype),
        pageCount: reopened.pageCount
    )
}
